import React from "react";
import { Image, Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { ExpoVideo } from "../optional-deps";
import { useSafeAreaInsetsMaybe } from "./insets";
import { useStrings } from "./strings";

export type LightboxItem = { kind: "image" | "video"; url: string; name: string };

/**
 * A task's screenshots and demo videos, full screen, one at a time, with
 * previous and next as on the web. Buttons only, no gestures, so the system
 * Modal (outside the host's gesture root) is safe here.
 */
export function Lightbox({
  items,
  index,
  onIndex,
  onClose,
}: {
  items: LightboxItem[];
  index: number | null;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const t = useStrings();
  const insets = useSafeAreaInsetsMaybe();
  const { width, height } = useWindowDimensions();
  const item = index !== null ? items[index] : null;
  return (
    <Modal visible={!!item} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.root}>
        {item ? (
          item.kind === "image" ? (
            <Image
              source={{ uri: item.url }}
              style={{ width, height: height - insets.top - insets.bottom - 140 }}
              resizeMode="contain"
              accessibilityLabel={item.name}
            />
          ) : ExpoVideo ? (
            <VideoItem key={item.url} url={item.url} width={width} height={height - insets.top - insets.bottom - 140} />
          ) : (
            <Text style={styles.name}>{item.name}</Text>
          )
        ) : null}
        <View style={[styles.top, { top: insets.top + 8 }]}>
          <Text style={styles.count}>
            {index !== null ? `${index + 1} / ${items.length}` : ""}
          </Text>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" style={styles.btn}>
            <Text style={styles.btnText}>{t("close")}</Text>
          </Pressable>
        </View>
        {items.length > 1 && index !== null ? (
          <View style={[styles.nav, { bottom: insets.bottom + 20 }]}>
            <Pressable
              onPress={() => onIndex((index - 1 + items.length) % items.length)}
              accessibilityRole="button"
              style={styles.btn}
            >
              <Text style={styles.btnText}>‹ {t("previous")}</Text>
            </Pressable>
            <Pressable onPress={() => onIndex((index + 1) % items.length)} accessibilityRole="button" style={styles.btn}>
              <Text style={styles.btnText}>{t("next")} ›</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

function VideoItem({ url, width, height }: { url: string; width: number; height: number }) {
  const V = ExpoVideo;
  const player = V.useVideoPlayer(url);
  return <V.VideoView player={player} style={{ width, height }} contentFit="contain" nativeControls />;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "rgba(0,0,0,0.94)", alignItems: "center", justifyContent: "center" },
  top: { position: "absolute", left: 16, right: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  count: { color: "#fff", fontSize: 15, fontVariant: ["tabular-nums"] },
  nav: { position: "absolute", left: 16, right: 16, flexDirection: "row", justifyContent: "space-between" },
  btn: { minHeight: 44, paddingHorizontal: 14, justifyContent: "center", borderRadius: 22, backgroundColor: "rgba(255,255,255,0.14)" },
  btnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  name: { color: "#fff", fontSize: 15 },
});
