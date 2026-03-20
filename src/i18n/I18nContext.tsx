import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { translations, type Lang } from "./translations";

interface I18nContextType {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: string) => string;
}

const I18nContext = createContext<I18nContextType>({
  lang: "en",
  setLang: () => {},
  t: (key) => key,
});

// Module-level accessor so non-component code (socket listeners) can translate
let currentT: (key: string) => string = (key) => key;
export function getT() { return currentT; }

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>("en");

  useEffect(() => {
    invoke<string | null>("load_language").then((saved) => {
      if (saved && saved in translations) setLangState(saved as Lang);
    }).catch(() => {});
  }, []);

  const setLang = useCallback((newLang: Lang) => {
    setLangState(newLang);
    invoke("save_language", { lang: newLang }).catch(() => {});
  }, []);

  const t = useCallback((key: string): string => {
    return translations[lang]?.[key as keyof typeof translations.en]
      ?? translations.en[key as keyof typeof translations.en]
      ?? key;
  }, [lang]);

  // Keep module-level accessor in sync
  currentT = t;

  return (
    <I18nContext.Provider value={{ lang, setLang, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}
