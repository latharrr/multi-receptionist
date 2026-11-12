import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// Envelope encryption (spec §3): a fresh data key encrypts the secret; the master key, which
// lives outside the database, encrypts the data key. `aad` binds the blob to its tenant and use.
const seal = (key: Buffer, aad: string, data: Buffer) => {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv).setAAD(Buffer.from(aad))
  return Buffer.concat([iv, c.update(data), c.final(), c.getAuthTag()])
}
const open = (key: Buffer, aad: string, blob: Buffer) => {
  const d = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12)).setAAD(Buffer.from(aad))
  d.setAuthTag(blob.subarray(-16))
  return Buffer.concat([d.update(blob.subarray(12, -16)), d.final()])
}

const WRAPPED = 12 + 32 + 16

export function sealSecret(master: Buffer, aad: string, plaintext: string): Buffer {
  const dataKey = randomBytes(32)
  return Buffer.concat([seal(master, aad, dataKey), seal(dataKey, aad, Buffer.from(plaintext))])
}
export function openSecret(master: Buffer, aad: string, blob: Buffer): string {
  const dataKey = open(master, aad, blob.subarray(0, WRAPPED))
  return open(dataKey, aad, blob.subarray(WRAPPED)).toString()
}
