// Small helpers shared by the drawing code.

// Unicode stand-ins: the Button label ignores nested Text styles, so bold is
// carried by the glyphs themselves.
export const toBold = (text: string) =>
  [...text]
    .map(ch => {
      const c = ch.codePointAt(0) ?? 0
      if (c >= 65 && c <= 90) return String.fromCodePoint(0x1d5d4 + c - 65)
      if (c >= 97 && c <= 122) return String.fromCodePoint(0x1d5ee + c - 97)
      if (c >= 48 && c <= 57) return String.fromCodePoint(0x1d7ec + c - 48)
      return ch
    })
    .join('')

// Plain spaces are collapsed or trimmed by the surface; non-breaking ones keep the width.
export const NBSP = '\u00a0'
