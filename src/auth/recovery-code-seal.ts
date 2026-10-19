import * as crypto from "crypto";
import { secretFingerprint } from "@/config/configuration.service";

/**
 * What a sealed recovery code looks like. Rows written before this sealing exist
 * too, as bare `sha256` hex digests, and are recognised by the absence of this
 * prefix — the same shape `VaultSettingsService` uses for `masterKeyHash`, for the
 * same reason: refusing them would strand every account that enrolled first.
 */
export const SEALED_RECOVERY_CODE_PREFIX = "hmac-sha256:";

/**
 * The pepper's name and its digest are both in the stored string, separated by
 * the last colon, because a digest that does not say which key made it is a
 * digest the next rotation can only guess about.
 */
const PEPPER_SEPARATOR = ":";

/**
 * The entropy behind one recovery code, in bytes.
 *
 * Twelve bytes is 96 bits, and it is what the stored digest is now worth: the
 * codes are printed for a person to read out over a support call or type from a
 * photo of their own screen, so they cannot be 32 random bytes of base64, and the
 * 32 bits the old two-`randomBytes(2)` pairs carried was nothing — a leaked
 * `MFASetting` row was ten unsalted digests over a 4.3-billion-key space, seconds
 * of GPU time, while the five-guess lockout that was supposed to be the brake
 * only ever limited the online half of the attack.
 */
export const RECOVERY_CODE_RANDOM_BYTES = 12;

/** The characters a code is broken into when it is shown, so a human can count them. */
const RECOVERY_CODE_GROUP_SIZE = 4;
const RECOVERY_CODE_GROUP_SEPARATOR = "-";

/**
 * Hex, upper-cased: no `G` through `Z` to misread as a letter, and specifically no
 * `I`, `L`, `O` or `U`, which is what makes a base32 secret miserable to transcribe
 * from a voice call. `0` and `1` do appear, and they are the residue of that — "oh"
 * for zero, "eye" for one — so these codes are for reading off a screen and typing,
 * never for dictating; `normaliseRecoveryCode` can absorb a lowercase letter or a
 * stray separator, but it cannot invent the character a holder misheard.
 *
 * 4 bits per character times the 24 characters a code shows is the whole 96, which
 * is why a narrower alphabet was not worth the entropy: the readability is bought
 * with a format instead of with a shorter keyspace.
 */
const RECOVERY_CODE_BITS_PER_CHARACTER = 4;

/**
 * One code's keyspace, in bits: the 24 characters a person sees carry 4 bits
 * apiece, which is exactly the 12 bytes that went into making them. Spelled out of
 * those two numbers rather than written as `96` so the constant and the sentence
 * describing it cannot disagree.
 */
export const RECOVERY_CODE_KEYSPACE_BITS =
  RECOVERY_CODE_RANDOM_BYTES * 2 * RECOVERY_CODE_BITS_PER_CHARACTER;

/** Every code this module mints, and every code it accepts, normalises the same way. */
const NON_ALPHANUMERIC = /[^0-9A-Z]/g;

/**
 * One pepper of the ring: the name a stored digest carries and the secret behind
 * it. Mirrors the vault's `PepperKey`; the vault's own helpers are module-private
 * in `vault-settings.service.ts`, so this flow keeps its copy here rather than
 * reaching across a module boundary.
 */
export interface RecoveryCodePepper {
  readonly id: string;
  readonly secret: string;
}

export interface RecoveryCodeMatch {
  /** The position of the entry the code opened, or `-1` when nothing matched. */
  readonly index: number;
  /**
   * Whether the entry that opened is a bare `sha256` digest rather than a sealed
   * one. The caller needs the distinction because a redeemed code is the only
   * moment its plaintext exists: an entry recognised by the legacy comparison can
   * be recorded under the pepper as it goes, which is what drains the row of
   * digests a leaked copy of it could still be cracked against.
   */
  readonly viaLegacyDigest: boolean;
  /**
   * Sealed entries naming a pepper this process was not given. They can neither
   * match nor be spent, so they are reported rather than silently refused.
   */
  readonly strandedPepperIds: string[];
}

/**
 * A code a person can write down: 24 hex characters in six dash-separated groups
 * of four. The dashes are display only — `normaliseRecoveryCode` removes them
 * again, so a digest depends on the 96 bits and not on where the typist put a
 * hyphen.
 */
export function generateRecoveryCode(): string {
  const hex = crypto
    .randomBytes(RECOVERY_CODE_RANDOM_BYTES)
    .toString("hex")
    .toUpperCase();

  return hex
    .match(new RegExp(`.{1,${RECOVERY_CODE_GROUP_SIZE}}`, "g"))!
    .join(RECOVERY_CODE_GROUP_SEPARATOR);
}

/**
 * Uppercase and strip everything a human might add — spaces, hyphens, a stray
 * tab from a copy out of an email. Deliberately not a validator: a code that is
 * the wrong shape normalises to a string that simply does not match any digest.
 */
export function normaliseRecoveryCode(code: string): string {
  return code.toUpperCase().replace(NON_ALPHANUMERIC, "");
}

/**
 * Names a pepper without trusting whoever supplied the name, exactly as the vault
 * does: the fingerprint of the secret is what separates two ring entries when an
 * operator sets a key and forgets the id beside it.
 */
export function recoveryCodePepper(
  secret: string,
  declaredId?: string,
): RecoveryCodePepper {
  return { id: declaredId?.trim() || secretFingerprint(secret), secret };
}

/**
 * The keyed digest, stamped with the pepper that made it.
 *
 * Keyed rather than bare so that a read of the database is not a read of a
 * guessable credential: `sha256(code)` with no key is a puzzle anyone holding the
 * row can work through offline, and a 96-bit code is only out of reach because the
 * work has to be done under a secret they do not have. The input is normalised
 * first, which is what lets minting and redemption agree without the caller
 * having to type the code the same way twice.
 */
export function sealRecoveryCode(
  code: string,
  pepper: RecoveryCodePepper,
): string {
  const digest = crypto
    .createHmac("sha256", pepper.secret)
    .update(normaliseRecoveryCode(code))
    .digest("base64");

  return `${SEALED_RECOVERY_CODE_PREFIX}${pepper.id}${PEPPER_SEPARATOR}${digest}`;
}

/** The bare `sha256` digest the rows written before this sealing were stored under. */
export function legacyRecoveryCodeDigest(code: string): string {
  return crypto.createHash("sha256").update(code.trim()).digest("hex");
}

/** Whether the row entry is a sealed digest (rather than a pre-sealing `sha256` hex). */
export function isSealedRecoveryCode(entry: string): boolean {
  return entry.startsWith(SEALED_RECOVERY_CODE_PREFIX);
}

/**
 * Which entry, if any, this code opens — sealed entries are tried first and the
 * bare `sha256` comparison runs only over the entries that predate the pepper, so
 * neither generation is stranded by the other. Which of the two routes opened is
 * reported with the index, because a legacy match is the one entry the caller can
 * still convert on the way out.
 *
 * Each entry names the pepper that sealed it, which is what makes a rotation
 * survivable: the digest is all the row holds, so an entry sealed under a retired
 * key can only be recognised by a process that still has that key. There is no
 * plaintext here to re-seal on the way past — spending a code deletes it — so the
 * retired pepper stays in the environment until every account has re-enabled MFA
 * at least once.
 *
 * An empty ring skips the keyed pass rather than failing it: with no
 * `ENCRYPTION_KEY` configured the deployment is broken, but a row of legacy
 * digests still opens, and refusing it would turn our outage into "wrong code" for
 * the one population whose codes never needed the key.
 */
export function matchRecoveryCode(
  entries: string[],
  rawCode: string,
  ring: RecoveryCodePepper[],
): RecoveryCodeMatch {
  const sealedDigests = ring.map((pepper) =>
    digestPart(sealRecoveryCode(rawCode, pepper)),
  );
  const stranded = new Set<string>();

  for (const [index, entry] of entries.entries()) {
    if (!isSealedRecoveryCode(entry) || sealedDigests.length === 0) continue;

    const { pepperId, digest } = splitEntry(entry);
    if (pepperId) {
      const candidates = sealedDigests
        .map((candidate, ringIndex) => ({ candidate, ringIndex }))
        .filter(({ ringIndex }) => ring[ringIndex].id === pepperId);

      if (candidates.length === 0) {
        stranded.add(pepperId);
        continue;
      }

      if (candidates.some(({ candidate }) => digestsMatch(digest, candidate))) {
        return {
          index,
          viaLegacyDigest: false,
          strandedPepperIds: [...stranded],
        };
      }
      continue;
    }

    // A sealed entry with no name on it can only be tried, the way the vault
    // treats a row that predates identifiers.
    if (sealedDigests.some((candidate) => digestsMatch(digest, candidate))) {
      return {
        index,
        viaLegacyDigest: false,
        strandedPepperIds: [...stranded],
      };
    }
  }

  const legacy = legacyRecoveryCodeDigest(rawCode);
  const legacyIndex = entries.findIndex(
    (entry) => !isSealedRecoveryCode(entry) && digestsMatch(entry, legacy),
  );

  return {
    index: legacyIndex,
    viaLegacyDigest: legacyIndex !== -1,
    strandedPepperIds: [...stranded],
  };
}

/**
 * `timingSafeEqual` throws on a length mismatch, and a digest's length is fixed by
 * its encoding rather than by anything secret, so comparing the lengths first
 * leaks nothing.
 */
function digestsMatch(stored: string, candidate: string): boolean {
  const expected = Buffer.from(stored);
  const received = Buffer.from(candidate);

  return (
    expected.length === received.length &&
    crypto.timingSafeEqual(expected, received)
  );
}

function splitEntry(entry: string): { pepperId: string; digest: string } {
  const body = entry.slice(SEALED_RECOVERY_CODE_PREFIX.length);
  const separatorIndex = body.lastIndexOf(PEPPER_SEPARATOR);
  if (separatorIndex === -1) {
    return { pepperId: "", digest: body };
  }

  return {
    pepperId: body.slice(0, separatorIndex),
    digest: body.slice(separatorIndex + PEPPER_SEPARATOR.length),
  };
}

function digestPart(sealed: string): string {
  return splitEntry(sealed).digest;
}
