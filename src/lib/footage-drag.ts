export const FOOTAGE_DRAG_TYPE = "application/x-project-footage";
export interface FootageRange { filename: string; start: number; end: number }
export function readFootageDrag(transfer: DataTransfer): FootageRange | null {
  try {
    const value = JSON.parse(transfer.getData(FOOTAGE_DRAG_TYPE));
    return typeof value.filename === "string" && Number.isFinite(value.start) && Number.isFinite(value.end) && value.start >= 0 && value.end > value.start ? value : null;
  } catch { return null; }
}
