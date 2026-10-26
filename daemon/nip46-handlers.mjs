import { NDKUser } from "@nostr-dev-kit/ndk";
import { isHexPubkey } from "./approvals.mjs";

// Replacements for NDKNip46Backend's encrypt/decrypt and get_public_key
// handlers. NDK's own encrypt/decrypt handlers pass only the payload string
// to permitCallback, so the approval prompt couldn't say who a message is to
// or from (QA bug 3); these pass the peer pubkey too, as `peerPubkey`.
// Otherwise they do exactly what NDK's do.
function cryptoHandler(method, scheme, direction) {
  return {
    async handle(backend, id, remotePubkey, params) {
      const [peerPubkey, payload] = Array.isArray(params) ? params : [];
      if (!isHexPubkey(peerPubkey)) throw new Error("invalid peer pubkey");
      if (typeof payload !== "string") throw new Error("missing payload");
      if (!await backend.pubkeyAllowed({ id, pubkey: remotePubkey, method, params: payload, peerPubkey })) return undefined;
      const peer = new NDKUser({ pubkey: peerPubkey.toLowerCase() });
      return direction === "encrypt"
        ? backend.signer.encrypt(peer, payload, scheme)
        : backend.signer.decrypt(peer, payload, scheme);
    },
  };
}

// NDK answers get_public_key for anyone, with no permitCallback call (QA bug
// 5). Answer it straight away only for an app that connected in this run
// or was remembered; anyone else goes through permitCallback like every
// other method.
function getPublicKeyHandler(isKnownClient) {
  return {
    async handle(backend, id, remotePubkey) {
      if (isKnownClient(remotePubkey) || await backend.pubkeyAllowed({ id, pubkey: remotePubkey, method: "get_public_key" })) {
        return backend.localUser?.pubkey;
      }
      return undefined;
    },
  };
}

export function installHandlers(backend, { isKnownClient }) {
  backend.setStrategy("nip04_encrypt", cryptoHandler("nip04_encrypt", "nip04", "encrypt"));
  backend.setStrategy("nip04_decrypt", cryptoHandler("nip04_decrypt", "nip04", "decrypt"));
  backend.setStrategy("nip44_encrypt", cryptoHandler("nip44_encrypt", "nip44", "encrypt"));
  backend.setStrategy("nip44_decrypt", cryptoHandler("nip44_decrypt", "nip44", "decrypt"));
  backend.setStrategy("get_public_key", getPublicKeyHandler(isKnownClient));
}
