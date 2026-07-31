#ifndef SPRINT_SIGNALS_CRASH_H
#define SPRINT_SIGNALS_CRASH_H

#include <stdbool.h>
#include <stddef.h>

/**
 * Native crash capture for Sprint Signals.
 *
 * WHAT THIS DOES AND DOES NOT DO
 *
 * A crashing process cannot be trusted to do anything complicated. Once a fatal
 * signal is delivered, the only operations that are safe are those on the
 * POSIX async-signal-safe list: no malloc, no Objective-C messaging, no Swift
 * runtime, no NSLog, no Foundation, no locks that a dead thread may hold.
 * Violating that is the classic "crash reporter deadlocks or corrupts the
 * report" bug, and it is why this lives in C with a pre-allocated buffer rather
 * than in Swift.
 *
 * So the handler does the minimum: writes a fixed-size record to a
 * pre-opened file descriptor using write(2), then re-raises the signal so the
 * OS (and any other installed reporter, e.g. Crashlytics) still sees it.
 * Everything else — parsing, enrichment, upload — happens on the NEXT launch,
 * from a healthy process.
 *
 * LIMITATION, stated plainly: the frames captured here are raw return
 * addresses. They are meaningless without a dSYM and a symbolication step.
 * Sprint has no symbolication pipeline yet, so until it does, these reports
 * arrive as hex addresses. That is why the Swift layer defaults
 * `enableCrashHandler` to false.
 */

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Install fatal-signal handlers.
 *
 * @param report_path  Absolute path the handler writes to on crash. Copied into
 *                     a static buffer immediately — the caller's string is not
 *                     retained, and no allocation happens at crash time.
 * @return true if handlers were installed.
 *
 * Safe to call once. A second call is a no-op.
 */
bool sprint_crash_install(const char *report_path);

/** Remove the handlers, restoring whatever was installed before. */
void sprint_crash_uninstall(void);

/** True if handlers are currently installed. */
bool sprint_crash_is_installed(void);

#ifdef __cplusplus
}
#endif

#endif /* SPRINT_SIGNALS_CRASH_H */
