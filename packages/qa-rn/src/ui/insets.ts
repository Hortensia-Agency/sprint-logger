import { Platform, StatusBar } from "react-native";

// react-native-safe-area-context is in nearly every Expo app but not a peer of
// this package: use it when the host has it, else a conservative guess.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let safeArea: any = null;
try {
  safeArea = require("react-native-safe-area-context");
} catch {
  safeArea = null;
}

const FALLBACK = {
  top: Platform.OS === "android" ? (StatusBar.currentHeight ?? 24) : 47,
  bottom: Platform.OS === "ios" ? 34 : 16,
  left: 0,
  right: 0,
};

/** The screen's safe insets for overlays drawn over the whole app. */
export const useSafeAreaInsetsMaybe: () => typeof FALLBACK =
  safeArea?.useSafeAreaInsets ?? (() => FALLBACK);
