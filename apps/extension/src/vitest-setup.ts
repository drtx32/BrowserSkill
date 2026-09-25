import { i18n } from "@browser-skill/i18n";
import { vi } from "vitest";

await i18n.changeLanguage("zh-CN");

vi.stubGlobal("chrome", {
  webNavigation: {
    getFrame: vi.fn(async () => ({ documentId: "test-doc" })),
  },
});
