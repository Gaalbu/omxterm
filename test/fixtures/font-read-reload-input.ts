// The expected child comes from the Surface's start receipt, never from input
// arrival. A wrong target or any sibling input cannot satisfy native usability.
export function receivedFontReloadInput(
  inputs: readonly (readonly string[])[],
  offsets: readonly number[],
  expected: number,
  token: string,
): boolean {
  return (
    inputs[expected] !== undefined &&
    inputs.every(
      (values, index) =>
        values.slice(offsets[index]).join("") ===
        (index === expected ? token : ""),
    )
  );
}
