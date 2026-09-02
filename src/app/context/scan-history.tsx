"use client";

import React, { createContext, useContext, useEffect, useState } from "react";
import type { ScanResult } from "@/lib/tikhub";
import type { Scan, ScanSeeds } from "@/lib/scan-storage";
import {
  generateScanId,
  loadAllScans,
  saveScan,
  deleteScan,
  deleteAllScans,
  importScansJSON,
  exportScansJSON,
} from "@/lib/scan-storage";

interface ScanHistoryContextValue {
  scans: Scan[];
  currentScanId: string | null;
  currentScan: Scan | null;
  isLoading: boolean;

  createScan(
    seeds: ScanSeeds,
    results: ScanResult,
    parentId?: string
  ): Scan;
  updateSelectedCandidates(scanId: string, candidates: string[]): void;
  setCurrentScanId(scanId: string | null): void;
  deleteScan(scanId: string): void;
  deleteAllScans(): void;

  exportScans(): string;
  importScans(json: string): void;
}

const ScanHistoryContext = createContext<ScanHistoryContextValue | undefined>(
  undefined
);

export function ScanHistoryProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [scans, setScans] = useState<Scan[]>([]);
  const [currentScanId, setCurrentScanId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Load scans from localStorage on mount
  useEffect(() => {
    setScans(loadAllScans());
    setIsLoading(false);
  }, []);

  const createScan = (
    seeds: ScanSeeds,
    results: ScanResult,
    parentId?: string
  ): Scan => {
    const id = generateScanId();
    const scan: Scan = {
      id,
      seeds,
      results,
      selectedCandidates: [],
      ...(parentId && { parentScanId: parentId }),
      timestamp: Date.now(),
    };
    saveScan(scan);
    setScans([...scans, scan]);
    return scan;
  };

  const updateSelectedCandidates = (
    scanId: string,
    candidates: string[]
  ): void => {
    const scan = scans.find((s) => s.id === scanId);
    if (scan) {
      scan.selectedCandidates = candidates;
      saveScan(scan);
      setScans([...scans]);
    }
  };

  const handleDeleteScan = (scanId: string): void => {
    deleteScan(scanId);
    setScans(scans.filter((s) => s.id !== scanId));
    if (currentScanId === scanId) {
      setCurrentScanId(null);
    }
  };

  const handleDeleteAllScans = (): void => {
    deleteAllScans();
    setScans([]);
    setCurrentScanId(null);
  };

  const exportScans = (): string => {
    return exportScansJSON(scans);
  };

  const importScans = (json: string): void => {
    try {
      const imported = importScansJSON(json);
      setScans(imported);
      imported.forEach(saveScan);
    } catch (e) {
      throw e;
    }
  };

  const value: ScanHistoryContextValue = {
    scans,
    currentScanId,
    currentScan: scans.find((s) => s.id === currentScanId) || null,
    isLoading,

    createScan,
    updateSelectedCandidates,
    setCurrentScanId,
    deleteScan: handleDeleteScan,
    deleteAllScans: handleDeleteAllScans,

    exportScans,
    importScans,
  };

  return (
    <ScanHistoryContext.Provider value={value}>
      {children}
    </ScanHistoryContext.Provider>
  );
}

export function useScanHistory(): ScanHistoryContextValue {
  const context = useContext(ScanHistoryContext);
  if (context === undefined) {
    throw new Error("useScanHistory must be used within ScanHistoryProvider");
  }
  return context;
}
