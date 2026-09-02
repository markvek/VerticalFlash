// Adapted from shadcn/ui (https://ui.shadcn.com), MIT licensed.
"use client";

import React, { useEffect, useRef, useState } from "react";

interface PopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: React.ReactNode;
  content: React.ReactNode;
}

export function Popover({
  open,
  onOpenChange,
  trigger,
  content,
}: PopoverProps) {
  const [position, setPosition] = useState<{ top: number; left: number }>({
    top: 0,
    left: 0,
  });
  const triggerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      // Estimated popover size for clamping (2 menu items)
      const popoverHeight = 110;
      const popoverWidth = 180;
      // Prefer below the trigger, but keep fully inside the viewport
      const top = Math.max(
        8,
        Math.min(rect.bottom + 8, window.innerHeight - popoverHeight - 8)
      );
      const left = Math.max(
        8,
        Math.min(rect.left, window.innerWidth - popoverWidth - 8)
      );
      setPosition({ top, left });
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        contentRef.current &&
        triggerRef.current &&
        !contentRef.current.contains(e.target as Node) &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        onOpenChange(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open, onOpenChange]);

  return (
    <>
      <div ref={triggerRef}>{trigger}</div>
      {open && (
        <div
          ref={contentRef}
          className="fixed z-50 rounded-lg border border-border bg-card shadow-lg"
          style={{
            top: `${position.top}px`,
            left: `${position.left}px`,
          }}
        >
          {content}
        </div>
      )}
    </>
  );
}
