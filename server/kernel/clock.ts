// The single source of "now" — wrapped so tests can hold time still.
export const now = (): number => Date.now();
