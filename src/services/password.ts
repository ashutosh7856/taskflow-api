const algorithm = "PBKDF2";
const digest = "SHA-256";
// Cloudflare Workers' Web Crypto implementation supports at most 100,000
// PBKDF2 iterations. Keep this at the platform maximum.
const iterations = 100_000;
const keyLength = 32;
const prefix = "pbkdf2-sha256";

export function passwordHashFormat(encoded: string) {
  if (encoded.startsWith(`${prefix}$`)) return "pbkdf2";
  if (encoded.startsWith("$argon2")) return "argon2";
  if (encoded.startsWith("$2")) return "bcrypt";
  return "unknown";
}

export function passwordNeedsRehash(encoded: string) {
  if (passwordHashFormat(encoded) !== "pbkdf2") return true;
  const rounds = Number(encoded.split("$")[1]);
  return rounds !== iterations;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function derive(password: string, salt: Uint8Array, rounds: number) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    algorithm,
    false,
    ["deriveBits"],
  );
  const saltBuffer = new Uint8Array(salt).buffer;
  const bits = await crypto.subtle.deriveBits(
    { name: algorithm, hash: digest, salt: saltBuffer, iterations: rounds },
    material,
    keyLength * 8,
  );
  return new Uint8Array(bits);
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, iterations);
  return `${prefix}$${iterations}$${bytesToBase64(salt)}$${bytesToBase64(hash)}`;
}

export async function verifyPassword(password: string, encoded: string) {
  const storedFormat = passwordHashFormat(encoded);
  if (storedFormat === "argon2" || storedFormat === "bcrypt") {
    // Bun.password created legacy hashes before the API moved to Workers.
    // This keeps Bun deployments compatible; legacy users need a password
    // reset after the API is moved to Cloudflare Workers.
    return typeof Bun !== "undefined"
      ? Bun.password.verify(password, encoded)
      : false;
  }

  const [format, roundsValue, saltValue, hashValue] = encoded.split("$");
  const rounds = Number(roundsValue);
  if (
    format !== prefix ||
    !Number.isSafeInteger(rounds) ||
    rounds < 1 ||
    !saltValue ||
    !hashValue
  ) {
    return false;
  }

  try {
    const expected = base64ToBytes(hashValue);
    const actual = await derive(password, base64ToBytes(saltValue), rounds);
    return constantTimeEqual(actual, expected);
  } catch {
    return false;
  }
}
