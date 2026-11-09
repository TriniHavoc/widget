// TTDx Wallet over WalletConnect 2.0 (socanet fork).
//
// The explorer pairs with the TTDx Wallet (Windows, Android) by QR code or wc: link, then sends
// cosmos_getAccounts / cosmos_signDirect requests that the user approves in the wallet.
// The project ID comes from <meta name="walletconnect-project-id" content="..."> on the page.
import { SignClient } from "@walletconnect/sign-client";
import type { SessionTypes } from "@walletconnect/types";
import { fromBase64, toBase64 } from "@cosmjs/encoding";
import { Registry, TxBodyEncodeObject, makeAuthInfoBytes, makeSignDoc } from "@cosmjs/proto-signing";
import { TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { Any } from "cosmjs-types/google/protobuf/any";
import { PubKey } from "cosmjs-types/cosmos/crypto/secp256k1/keys";
import QRCode from "qrcode";
import { AbstractWallet, Account, WalletArgument, WalletName, keyType } from "../Wallet";
import { Transaction } from "../../utils/type";

const METHODS = ["cosmos_getAccounts", "cosmos_signDirect"];

type Client = InstanceType<typeof SignClient>;

function projectId(): string {
    const meta = document.querySelector('meta[name="walletconnect-project-id"]')?.getAttribute("content")?.trim();
    // An unreplaced %VITE_...% placeholder means the explorer was built without one.
    if (!meta || meta.startsWith("%")) {
        throw new Error("WalletConnect is not configured on this explorer (no project ID)");
    }
    return meta;
}

// One client per page: the explorer creates a new wallet object for every transaction,
// and sessions must survive that (and page reloads, which SignClient keeps in localStorage).
let clientPromise: Promise<Client> | undefined;
function client(): Promise<Client> {
    if (!clientPromise) {
        clientPromise = SignClient.init({
            projectId: projectId(),
            metadata: {
                name: "socanet explorer",
                description: "socanet block explorer",
                url: location.origin,
                icons: [`${location.origin}/socanet-logo.png`],
            },
        }).catch((e: unknown) => {
            clientPromise = undefined;
            throw e;
        });
    }
    return clientPromise;
}

const caip2 = (chainId: string) => `cosmos:${chainId}`;

function liveSession(c: Client, chainId: string): SessionTypes.Struct | undefined {
    const now = Date.now() / 1000;
    return c.session
        .getAll()
        .filter((s) => s.expiry > now && (s.namespaces.cosmos?.accounts ?? []).some((a) => a.startsWith(`${caip2(chainId)}:`)))
        .sort((a, b) => b.expiry - a.expiry)[0];
}

/** Ends every WalletConnect session this page holds (called on Disconnect). */
export async function disconnectTTDxWallet() {
    if (!clientPromise) {
        try {
            projectId();
        } catch {
            return;
        }
    }
    const c = await client();
    await Promise.all(
        c.session.getAll().map((s) =>
            c.disconnect({ topic: s.topic, reason: { code: 6000, message: "User disconnected." } }).catch(() => {})
        )
    );
}

export class TTDxWallet implements AbstractWallet {
    name = WalletName.TTDx as const;
    chainId: string;
    registry: Registry;
    conf: WalletArgument;

    constructor(arg: WalletArgument, registry: Registry) {
        if (!arg.chainId) throw new Error("No chain ID");
        this.chainId = arg.chainId;
        this.registry = registry;
        this.conf = arg;
    }

    private async session(): Promise<[Client, SessionTypes.Struct]> {
        const c = await client();
        const existing = liveSession(c, this.chainId);
        if (existing) return [c, existing];

        const { uri, approval } = await c.connect({
            optionalNamespaces: { cosmos: { chains: [caip2(this.chainId)], methods: METHODS, events: [] } },
        });
        if (!uri) throw new Error("WalletConnect did not return a pairing link");
        const modal = await showPairing(uri);
        try {
            return [c, await Promise.race([approval(), modal.cancelled])];
        } finally {
            modal.close();
        }
    }

    private async request<T>(method: string, params: unknown): Promise<T> {
        const [c, s] = await this.session();
        const note = method === "cosmos_getAccounts" ? undefined : showNotice("Approve this transaction in your TTDx Wallet.");
        try {
            return await c.request<T>({ topic: s.topic, chainId: caip2(this.chainId), request: { method, params } });
        } finally {
            note?.();
        }
    }

    async getAccounts(): Promise<Account[]> {
        const accounts = await this.request<{ address: string; algo: string; pubkey: string }[]>("cosmos_getAccounts", {});
        return accounts.map((a) => ({ address: a.address, algo: a.algo, pubkey: fromBase64(a.pubkey) }));
    }

    supportCoinType(): Promise<boolean> {
        return Promise.resolve(true);
    }

    async sign(tx: Transaction): Promise<TxRaw> {
        const account = (await this.getAccounts()).find((a) => a.address === tx.signerAddress);
        if (!account) {
            throw new Error(`The connected TTDx Wallet is not ${tx.signerAddress}. Disconnect and connect again.`);
        }
        const pubkey = Any.fromPartial({
            typeUrl: keyType(tx.chainId),
            value: PubKey.encode({ key: account.pubkey }).finish(),
        });
        const body: TxBodyEncodeObject = {
            typeUrl: "/cosmos.tx.v1beta1.TxBody",
            value: { messages: tx.messages, memo: tx.memo },
        };
        const authInfoBytes = makeAuthInfoBytes(
            [{ pubkey, sequence: tx.signerData.sequence }],
            tx.fee.amount,
            Number(tx.fee.gas),
            tx.fee.granter,
            tx.fee.payer
        );
        const doc = makeSignDoc(this.registry.encode(body), authInfoBytes, tx.chainId, tx.signerData.accountNumber);
        const res = await this.request<{
            signature: { signature: string };
            signed: { bodyBytes: string; authInfoBytes: string };
        }>("cosmos_signDirect", {
            signerAddress: tx.signerAddress,
            signDoc: {
                chainId: doc.chainId,
                accountNumber: doc.accountNumber.toString(),
                bodyBytes: toBase64(doc.bodyBytes),
                authInfoBytes: toBase64(doc.authInfoBytes),
            },
        });
        return TxRaw.fromPartial({
            bodyBytes: fromBase64(res.signed.bodyBytes),
            authInfoBytes: fromBase64(res.signed.authInfoBytes),
            signatures: [fromBase64(res.signature.signature)],
        });
    }
}

// ------------------------------------------------------------------------------ UI
// Plain DOM with inline styles, so it looks the same whatever page hosts the widget.

const PANEL =
    "background:#141417;color:#fff;border:1px solid #29292f;border-radius:18px;padding:24px;" +
    "font-family:'Plus Jakarta Sans',system-ui,sans-serif;box-shadow:0 20px 60px #000a;";
const BUTTON =
    "border:1px solid #3a3a42;background:#1d1d22;color:#fff;border-radius:10px;padding:10px 16px;" +
    "font:600 13px system-ui,sans-serif;cursor:pointer;";

function el(tag: string, style: string, text?: string) {
    const e = document.createElement(tag);
    e.setAttribute("style", style);
    if (text) e.textContent = text;
    return e;
}

async function showPairing(uri: string): Promise<{ cancelled: Promise<never>; close: () => void }> {
    const svg = await QRCode.toString(uri, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
    const overlay = el(
        "div",
        "position:fixed;inset:0;z-index:2147483647;background:#000b;display:flex;align-items:center;justify-content:center;padding:16px;"
    );
    const panel = el("div", PANEL + "width:min(360px,100%);text-align:center;");
    panel.append(el("div", "font:700 20px system-ui,sans-serif;margin-bottom:6px;", "Connect your TTDx Wallet"));
    panel.append(
        el(
            "div",
            "font-size:13px;color:#9999a3;line-height:1.5;margin-bottom:16px;",
            "In the wallet, open Connect a dApp. On a phone, scan this code. On Windows, copy the link and paste it."
        )
    );
    const qr = el("div", "background:#fff;border-radius:14px;padding:12px;margin:0 auto 16px;width:240px;height:240px;");
    qr.innerHTML = svg; // generated by the qrcode library from the wc: link
    const qrSvg = qr.querySelector("svg");
    if (qrSvg) qrSvg.setAttribute("style", "width:100%;height:100%;display:block;");
    panel.append(qr);

    const row = el("div", "display:flex;gap:10px;justify-content:center;");
    const copy = el("button", BUTTON, "Copy link");
    const cancel = el("button", BUTTON + "background:#e11937;border-color:#e11937;", "Cancel");
    row.append(copy, cancel);
    panel.append(row);
    overlay.append(panel);
    document.body.append(overlay);

    copy.addEventListener("click", async () => {
        try {
            await navigator.clipboard.writeText(uri);
            copy.textContent = "Copied";
        } catch {
            copy.textContent = "Copy failed";
        }
    });
    let reject: (e: Error) => void = () => {};
    const cancelled = new Promise<never>((_, r) => (reject = r));
    cancelled.catch(() => {}); // handled by the caller's race
    cancel.addEventListener("click", () => reject(new Error("Connection cancelled")));
    return { cancelled, close: () => overlay.remove() };
}

function showNotice(text: string): () => void {
    const box = el(
        "div",
        PANEL + "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;padding:14px 20px;font-size:14px;"
    );
    box.textContent = text;
    document.body.append(box);
    return () => box.remove();
}
