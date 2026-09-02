"use client";

import React, { createContext, useContext } from "react";
import type { PublicBrandConfig } from "@/lib/brand";

const BrandContext = createContext<PublicBrandConfig | undefined>(undefined);

// The root layout (a server component) reads brand.config.json and hands
// the browser-safe subset down here, so client components never touch fs.
export function BrandProvider({
  value,
  children,
}: {
  value: PublicBrandConfig;
  children: React.ReactNode;
}) {
  return (
    <BrandContext.Provider value={value}>{children}</BrandContext.Provider>
  );
}

export function useBrand(): PublicBrandConfig {
  const context = useContext(BrandContext);
  if (context === undefined) {
    throw new Error("useBrand must be used within BrandProvider");
  }
  return context;
}
