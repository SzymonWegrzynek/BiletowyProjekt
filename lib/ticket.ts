import { randomBytes } from "node:crypto";

// 32 znaki bez mylących 0/O i 1/I. 256 dzieli się przez 32, więc każdy znak
// jest równie prawdopodobny. 32^6 ≈ 1 mld kodów.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// Format czytelny dla człowieka, np. "TEA-7F3K9Q".
export function generateTicketCode(): string {
  let code = "TEA-";
  for (const byte of randomBytes(6)) code += ALPHABET[byte % ALPHABET.length];
  return code;
}
