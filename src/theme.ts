/* AGPL-3.0-or-later */
import { createTheme, DEFAULT_THEME } from "@mantine/core";

// Nunito everywhere; fall back to Mantine's default system stack. Loaded via
// @fontsource/nunito in main.tsx.
const nunito = `Nunito, ${DEFAULT_THEME.fontFamily}`;

export const theme = createTheme({
  fontFamily: nunito,
  fontFamilyMonospace: DEFAULT_THEME.fontFamilyMonospace,
  headings: { fontFamily: nunito, fontWeight: "700" },
  primaryColor: "indigo",
  defaultRadius: "md",
});
