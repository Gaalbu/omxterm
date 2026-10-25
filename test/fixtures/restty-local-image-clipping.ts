import assert from "node:assert/strict";
import type { LocalImageCoreCells } from "./restty-local-image-root";

export function localImageClippingReady(
  cells: LocalImageCoreCells | null,
  reference: string,
  plan: ReturnType<typeof planLocalImageClipping>,
  scrollRows: 0 | 1 = 0,
) {
  if (!cells || cells.cols !== plan.cols || cells.rows !== plan.rows)
    return false;
  const lead = Array.from(
    { length: plan.leadRows },
    (_, index) => `lead-${index}`,
  );
  const expected = [
    ...lead.slice(scrollRows),
    reference +
      (scrollRows ? " ".repeat(plan.paddingCells) + "continuation.png" : ""),
  ].join("\n");
  const start = (plan.leadRows - scrollRows) * plan.cols;
  const paddingStart = start + plan.pathColumns;
  const paddingEnd = (plan.rows - scrollRows) * plan.cols;
  const click = (plan.clickRow - scrollRows) * plan.cols + plan.clickCol;
  // Selection drops final spaces. Prove the logical text AND literal physical
  // spaces, not blank cells, with a click on the visible path rather than padding.
  return (
    cells.text === expected &&
    cells.codepoints.length === plan.cols * plan.rows &&
    plan.clickRow === plan.leadRows &&
    plan.clickCol === 2 &&
    cells.codepoints[start] === reference.codePointAt(0) &&
    click >= start &&
    click < paddingStart &&
    cells.codepoints
      .slice(paddingStart, paddingEnd)
      .every((point) => point === 32)
  );
}

// Physical endpoint measured on the active grid, not a string-width estimate.
export function planLocalImageClipping(
  reference: string,
  pathColumns: number,
  size: { cols: number; rows: number },
) {
  // The suffix must occupy one row; the original column-2 click stays in path.
  assert.ok(
    Number.isSafeInteger(size.cols) &&
      size.cols >= 16 &&
      Number.isSafeInteger(size.rows) &&
      size.rows >= 2 &&
      Number.isSafeInteger(pathColumns) &&
      pathColumns > 2 &&
      Number.isSafeInteger(size.cols * size.rows),
    `Invalid local image clipping geometry: ${JSON.stringify({ ...size, pathColumns })}`,
  );
  // An exact wrap still needs a full row of literal spaces before the suffix.
  const prefixRows = Math.floor(pathColumns / size.cols) + 1;
  const paddingCells = prefixRows * size.cols - pathColumns;
  const leadRows = size.rows - prefixRows;
  assert.ok(
    leadRows >= 1,
    `Local image clipping capacity exceeded: ${JSON.stringify({ pathColumns, ...size, prefixRows })}`,
  );
  const lead = Array.from({ length: leadRows }, (_, index) => `lead-${index}`);
  const trailing = Array.from(
    { length: size.rows },
    (_, index) => `trail-${index}`,
  );
  return {
    ...size,
    pathColumns,
    prefixRows,
    paddingCells,
    leadRows,
    clickRow: leadRows,
    clickCol: 2,
    output: `\u001b[3J\u001b[2J\u001b[H${lead.join("\r\n")}\r\n${reference}${" ".repeat(paddingCells)}continuation.png\r\n${trailing.join("\r\n")}`,
  };
}
