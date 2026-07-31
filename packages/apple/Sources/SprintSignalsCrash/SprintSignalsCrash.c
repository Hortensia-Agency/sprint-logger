#include "include/SprintSignalsCrash.h"

#include <signal.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <execinfo.h>
#include <stdint.h>
#include <time.h>
#include <errno.h>
#include <mach-o/dyld.h>
#include <mach-o/loader.h>
#include <mach-o/getsect.h>

// Everything below runs, or may run, inside a signal handler. The rules:
//   - No malloc/free (the allocator lock may be held by the crashed thread).
//   - No Objective-C / Swift runtime (both allocate and take locks).
//   - No stdio (printf family buffers and allocates). write(2) only.
//   - Only volatile sig_atomic_t for state mutated across handler boundaries.
// All storage is therefore static and pre-sized.

#define SPRINT_PATH_MAX 1024
#define SPRINT_MAX_FRAMES 128
// Only the images a crash can plausibly land in are worth recording: the main
// executable and the app's own frameworks. A modern app loads 300+ system
// dylibs whose symbols we could never resolve anyway (no dSYM for them), so
// recording all of them would bloat every report for nothing.
#define SPRINT_MAX_IMAGES 64
#define SPRINT_IMAGE_NAME_MAX 128

static char g_report_path[SPRINT_PATH_MAX];
static volatile sig_atomic_t g_installed = 0;
static volatile sig_atomic_t g_handling = 0;

// Pre-allocated frame buffer. backtrace() writes into caller-provided storage,
// so no allocation happens at crash time.
static void *g_frames[SPRINT_MAX_FRAMES];

/**
 * One loaded binary image. Without these, captured addresses are USELESS: ASLR
 * slides every image to a different base each launch, so a raw address means
 * nothing without (base, uuid) to turn it back into a file-relative offset that
 * a dSYM can resolve.
 *
 * Snapshotted at INSTALL time, where allocation and dyld calls are legal. The
 * handler only writes these pre-computed bytes — it never walks dyld, which is
 * not async-signal-safe.
 */
typedef struct {
    uintptr_t load_address;
    uintptr_t size;
    uint8_t uuid[16];
    char name[SPRINT_IMAGE_NAME_MAX];
    int has_uuid;
} sprint_image_t;

static sprint_image_t g_images[SPRINT_MAX_IMAGES];
static int g_image_count = 0;

// The signals worth catching. SIGKILL/SIGSTOP are uncatchable by design;
// SIGPIPE is deliberately excluded (routine on socket teardown, not a crash).
static const int kFatalSignals[] = {
    SIGABRT, SIGBUS, SIGFPE, SIGILL, SIGSEGV, SIGSYS, SIGTRAP,
};
static const size_t kFatalSignalCount =
    sizeof(kFatalSignals) / sizeof(kFatalSignals[0]);

static struct sigaction g_previous[sizeof(kFatalSignals) / sizeof(int)];

/** Async-signal-safe unsigned-to-decimal. Returns bytes written. */
static size_t sprint_utoa(uint64_t value, char *out, size_t out_size) {
    if (out_size == 0) return 0;
    char tmp[24];
    size_t len = 0;
    if (value == 0) {
        tmp[len++] = '0';
    } else {
        while (value > 0 && len < sizeof(tmp)) {
            tmp[len++] = (char)('0' + (value % 10));
            value /= 10;
        }
    }
    size_t written = 0;
    while (len > 0 && written < out_size) {
        out[written++] = tmp[--len];
    }
    return written;
}

/** Async-signal-safe pointer-to-hex ("0x" prefixed). Returns bytes written. */
static size_t sprint_ptoa(uintptr_t value, char *out, size_t out_size) {
    static const char kHex[] = "0123456789abcdef";
    if (out_size < 3) return 0;
    size_t written = 0;
    out[written++] = '0';
    out[written++] = 'x';
    int started = 0;
    for (int shift = (int)(sizeof(uintptr_t) * 8) - 4; shift >= 0; shift -= 4) {
        char digit = kHex[(value >> shift) & 0xF];
        if (!started && digit == '0' && shift > 0) continue;
        started = 1;
        if (written >= out_size) break;
        out[written++] = digit;
    }
    return written;
}

/** Basename of a path, into a fixed buffer. No allocation. */
static void sprint_copy_basename(const char *path, char *out, size_t out_size) {
    if (out_size == 0) return;
    out[0] = '\0';
    if (!path) return;
    const char *base = strrchr(path, '/');
    base = base ? base + 1 : path;
    size_t len = strlen(base);
    if (len >= out_size) len = out_size - 1;
    memcpy(out, base, len);
    out[len] = '\0';
}

/**
 * Extract LC_UUID and the __TEXT vmsize from a loaded Mach-O header.
 * Returns 1 if a UUID was found.
 *
 * Runs at install time only.
 */
static int sprint_read_image_meta(const struct mach_header_64 *header,
                                  uint8_t out_uuid[16],
                                  uintptr_t *out_size) {
    if (!header || header->magic != MH_MAGIC_64) return 0;

    const struct load_command *cmd =
        (const struct load_command *)((const uint8_t *)header + sizeof(struct mach_header_64));
    int found_uuid = 0;

    for (uint32_t i = 0; i < header->ncmds; i++) {
        if (cmd->cmd == LC_UUID) {
            const struct uuid_command *uc = (const struct uuid_command *)cmd;
            memcpy(out_uuid, uc->uuid, 16);
            found_uuid = 1;
        } else if (cmd->cmd == LC_SEGMENT_64) {
            const struct segment_command_64 *seg = (const struct segment_command_64 *)cmd;
            // __TEXT vmsize bounds the executable region — used to decide which
            // image an address belongs to.
            if (strcmp(seg->segname, SEG_TEXT) == 0) {
                *out_size = (uintptr_t)seg->vmsize;
            }
        }
        cmd = (const struct load_command *)((const uint8_t *)cmd + cmd->cmdsize);
    }
    return found_uuid;
}

/**
 * Snapshot the loaded images worth symbolicating: the main executable plus
 * anything inside the app bundle (.app/.framework), skipping system libraries
 * in the dyld shared cache. Install-time only — dyld APIs take locks and are
 * not async-signal-safe.
 */
static void sprint_snapshot_images(void) {
    g_image_count = 0;
    uint32_t count = _dyld_image_count();

    for (uint32_t i = 0; i < count && g_image_count < SPRINT_MAX_IMAGES; i++) {
        const char *path = _dyld_get_image_name(i);
        if (!path) continue;

        // Index 0 is the main executable — always keep it. Otherwise keep only
        // images that live in the app bundle; system dylibs have no dSYM we
        // could ever match, so recording them is pure noise.
        int is_main = (i == 0);
        int in_bundle = (strstr(path, ".app/") != NULL) ||
                        (strstr(path, ".framework/") != NULL);
        if (!is_main && !in_bundle) continue;
        // Never record the shared cache — those are Apple's, not ours.
        if (strstr(path, "/usr/lib/") != NULL) continue;
        if (strstr(path, "/System/Library/") != NULL) continue;

        const struct mach_header *mh = _dyld_get_image_header(i);
        if (!mh) continue;

        sprint_image_t *img = &g_images[g_image_count];
        memset(img, 0, sizeof(*img));
        img->load_address = (uintptr_t)mh;
        img->has_uuid = sprint_read_image_meta(
            (const struct mach_header_64 *)mh, img->uuid, &img->size);
        sprint_copy_basename(path, img->name, sizeof(img->name));

        g_image_count++;
    }
}

/** write(2) loop — handles partial writes and EINTR. */
static void sprint_write_all(int fd, const char *buf, size_t len) {
    size_t off = 0;
    while (off < len) {
        ssize_t n = write(fd, buf + off, len - off);
        if (n <= 0) {
            if (n < 0 && errno == EINTR) continue;
            return;
        }
        off += (size_t)n;
    }
}

static void sprint_write_str(int fd, const char *s) {
    sprint_write_all(fd, s, strlen(s));
}

/** Write 16 raw bytes as a 32-char lowercase hex UUID. Async-signal-safe. */
static void sprint_write_uuid(int fd, const uint8_t uuid[16]) {
    static const char kHex[] = "0123456789abcdef";
    char buf[32];
    for (int i = 0; i < 16; i++) {
        buf[i * 2] = kHex[(uuid[i] >> 4) & 0xF];
        buf[i * 2 + 1] = kHex[uuid[i] & 0xF];
    }
    sprint_write_all(fd, buf, sizeof(buf));
}

/**
 * The handler. Writes a minimal JSON-ish record and re-raises.
 *
 * Deliberately NOT valid JSON assembly via any library — this is hand-emitted
 * with write(2) so nothing allocates. The Swift side parses it on next launch.
 */
static void sprint_crash_handler(int signo, siginfo_t *info, void *context) {
    (void)context;

    // Re-entrancy guard: a crash inside the handler must not loop forever.
    if (g_handling) {
        _exit(1);
    }
    g_handling = 1;

    int fd = open(g_report_path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (fd >= 0) {
        char num[24];
        size_t n;

        sprint_write_str(fd, "{\"v\":1,\"signal\":");
        n = sprint_utoa((uint64_t)signo, num, sizeof(num));
        sprint_write_all(fd, num, n);

        sprint_write_str(fd, ",\"code\":");
        n = sprint_utoa((uint64_t)(info ? info->si_code : 0), num, sizeof(num));
        sprint_write_all(fd, num, n);

        sprint_write_str(fd, ",\"address\":");
        n = sprint_utoa((uint64_t)(uintptr_t)(info ? info->si_addr : 0), num, sizeof(num));
        sprint_write_all(fd, num, n);

        // Wall-clock seconds. time() is not on the strict POSIX
        // async-signal-safe list, but it is a vDSO read on Darwin with no
        // allocation or locking. The alternative (no timestamp at all) is worse
        // for a report that may sit on disk for days before upload.
        sprint_write_str(fd, ",\"at\":");
        n = sprint_utoa((uint64_t)time(NULL), num, sizeof(num));
        sprint_write_all(fd, num, n);

        // backtrace() on Darwin walks the frame pointer chain and does not
        // allocate when given caller storage. backtrace_symbols() DOES malloc —
        // never call it here; addresses are resolved off-device instead.
        sprint_write_str(fd, ",\"frames\":[");
        int frame_count = backtrace(g_frames, SPRINT_MAX_FRAMES);
        for (int i = 0; i < frame_count; i++) {
            if (i > 0) sprint_write_str(fd, ",");
            sprint_write_str(fd, "\"");
            n = sprint_ptoa((uintptr_t)g_frames[i], num, sizeof(num));
            sprint_write_all(fd, num, n);
            sprint_write_str(fd, "\"");
        }
        sprint_write_str(fd, "]");

        // The binary images, snapshotted at install time. WITHOUT THIS the
        // frame addresses above cannot be symbolicated by anything: ASLR means
        // the same code sits at a different address every launch, so a resolver
        // needs (load_address, uuid) to convert a runtime address back into the
        // file-relative offset a dSYM is keyed by.
        sprint_write_str(fd, ",\"images\":[");
        for (int i = 0; i < g_image_count; i++) {
            const sprint_image_t *img = &g_images[i];
            if (i > 0) sprint_write_str(fd, ",");
            sprint_write_str(fd, "{\"name\":\"");
            sprint_write_str(fd, img->name);
            sprint_write_str(fd, "\",\"base\":");
            n = sprint_utoa((uint64_t)img->load_address, num, sizeof(num));
            sprint_write_all(fd, num, n);
            sprint_write_str(fd, ",\"size\":");
            n = sprint_utoa((uint64_t)img->size, num, sizeof(num));
            sprint_write_all(fd, num, n);
            if (img->has_uuid) {
                sprint_write_str(fd, ",\"uuid\":\"");
                sprint_write_uuid(fd, img->uuid);
                sprint_write_str(fd, "\"");
            }
            sprint_write_str(fd, "}");
        }
        sprint_write_str(fd, "]}");

        // fsync so the record survives the imminent process death. Without it
        // the page cache may never reach disk if the OS tears us down fast.
        fsync(fd);
        close(fd);
    }

    // Restore the previous handler and re-raise, so the OS still produces its
    // own crash log and any other installed reporter (Crashlytics) still runs.
    // Swallowing the signal here would silently break existing crash reporting.
    for (size_t i = 0; i < kFatalSignalCount; i++) {
        if (kFatalSignals[i] == signo) {
            sigaction(signo, &g_previous[i], NULL);
            break;
        }
    }
    raise(signo);
}

bool sprint_crash_install(const char *report_path) {
    if (g_installed) return true;
    if (report_path == NULL) return false;

    size_t len = strlen(report_path);
    if (len == 0 || len >= SPRINT_PATH_MAX) return false;
    // Copy now — at crash time we cannot dereference a Swift-owned string.
    memcpy(g_report_path, report_path, len);
    g_report_path[len] = '\0';

    // Snapshot loaded images BEFORE arming handlers — this walks dyld, which is
    // not async-signal-safe and must never run from the handler.
    sprint_snapshot_images();

    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_sigaction = sprint_crash_handler;
    action.sa_flags = SA_SIGINFO | SA_ONSTACK;
    sigemptyset(&action.sa_mask);

    for (size_t i = 0; i < kFatalSignalCount; i++) {
        if (sigaction(kFatalSignals[i], &action, &g_previous[i]) != 0) {
            // Roll back partial installation rather than leave a half-armed
            // handler chain behind.
            for (size_t j = 0; j < i; j++) {
                sigaction(kFatalSignals[j], &g_previous[j], NULL);
            }
            return false;
        }
    }

    g_installed = 1;
    return true;
}

void sprint_crash_uninstall(void) {
    if (!g_installed) return;
    for (size_t i = 0; i < kFatalSignalCount; i++) {
        sigaction(kFatalSignals[i], &g_previous[i], NULL);
    }
    g_installed = 0;
}

bool sprint_crash_is_installed(void) {
    return g_installed != 0;
}
