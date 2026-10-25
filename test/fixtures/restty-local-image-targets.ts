export function localImageReferenceCells(options: {
  readonly cols: number;
  readonly reference: string;
  readonly prefixColumns: number;
  readonly rootCellDelta: number;
}): number[] {
  const { cols, reference, prefixColumns, rootCellDelta } = options;
  const destinationColumns = reference.length + rootCellDelta;
  return [
    ...new Set([
      prefixColumns + 2,
      prefixColumns + reference.lastIndexOf(" ") + rootCellDelta,
      prefixColumns + reference.lastIndexOf("photo") + rootCellDelta,
      // A short continuation may end before column 2 of the next row.
      ...(prefixColumns + destinationColumns > cols
        ? [Math.min(cols + 2, prefixColumns + destinationColumns - 1)]
        : []),
    ]),
  ];
}
