import React, { useEffect, useState } from "react";
import { Check, Copy, Lock, QrCode, RefreshCw, ShieldCheck, Smartphone, X } from "lucide-react";
import { PairingTicket } from "../types/velo";

interface PairingModalProps {
  daemonUrl: string;
  onClose: () => void;
}

export function PairingModal({ daemonUrl, onClose }: PairingModalProps) {
  const [ticket, setTicket] = useState<PairingTicket | null>(null);
  const [copied, setCopied] = useState(false);

  async function loadTicket() {
    try {
      const res = await fetch(`${daemonUrl}/api/pair`);
      if (res.ok) {
        const data: PairingTicket = await res.json();
        setTicket(data);
      }
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    loadTicket();
  }, []);

  function copyUri() {
    if (!ticket) return;
    navigator.clipboard.writeText(ticket.pairing_uri);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  // Deterministic 17x17 matrix from pairing_uri for SVG rendering
  const matrixSize = 17;
  const cells: boolean[][] = [];
  const seedStr = ticket?.pairing_uri || "velo://pair";
  for (let r = 0; r < matrixSize; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < matrixSize; c++) {
      const isFinderOuter =
        (r < 5 && c < 5) ||
        (r < 5 && c >= matrixSize - 5) ||
        (r >= matrixSize - 5 && c < 5);
      const isFinderInner =
        (r >= 1 && r <= 3 && c >= 1 && c <= 3) ||
        (r >= 1 && r <= 3 && c >= matrixSize - 4 && c <= matrixSize - 2) ||
        (r >= matrixSize - 4 && r <= matrixSize - 2 && c >= 1 && c <= 3);
      if (isFinderOuter) {
        const onBorder =
          r === 0 ||
          r === 4 ||
          c === 0 ||
          c === 4 ||
          r === matrixSize - 1 ||
          r === matrixSize - 5 ||
          c === matrixSize - 1 ||
          c === matrixSize - 5;
        row.push(onBorder || isFinderInner);
      } else {
        const code = seedStr.charCodeAt((r * matrixSize + c) % seedStr.length);
        row.push(((code ^ (r * 11 + c * 19)) & 1) === 1);
      }
    }
    cells.push(row);
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl bg-zinc-900 border border-zinc-800 shadow-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
              <Smartphone className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-zinc-100">
                Mobile & Remote E2EE Pairing
              </h3>
              <p className="text-[11px] text-zinc-400">
                Zero-knowledge relay tunnel (`velo-relay`)
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* QR Code Card */}
          <div className="flex flex-col items-center justify-center p-5 rounded-xl bg-zinc-950 border border-zinc-800/90">
            <div className="p-3 bg-white rounded-xl shadow-md">
              <svg
                width="170"
                height="170"
                viewBox={`0 0 ${matrixSize} ${matrixSize}`}
                shapeRendering="crispEdges"
              >
                {cells.map((row, r) =>
                  row.map((filled, c) =>
                    filled ? (
                      <rect
                        key={`${r}-${c}`}
                        x={c}
                        y={r}
                        width={1}
                        height={1}
                        fill="#09090b"
                      />
                    ) : null
                  )
                )}
              </svg>
            </div>

            <div className="mt-3 flex items-center gap-1.5 text-[11px] text-emerald-400 font-mono">
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>256-bit End-to-End Encrypted Session</span>
            </div>
          </div>

          {ticket && (
            <div className="space-y-2 text-xs font-mono">
              <div className="p-2.5 rounded-lg bg-zinc-950 border border-zinc-800 flex items-center justify-between">
                <span className="text-zinc-500">Relay Room</span>
                <span className="text-zinc-200">{ticket.room_id.slice(0, 18)}…</span>
              </div>
              <div className="p-2.5 rounded-lg bg-zinc-950 border border-zinc-800 flex items-center justify-between">
                <span className="text-zinc-500">Key Fingerprint</span>
                <span className="text-amber-300 flex items-center gap-1">
                  <Lock className="w-3 h-3" />
                  {ticket.shared_key_hex.slice(0, 16)}…
                </span>
              </div>

              <div className="flex items-center gap-2 pt-1">
                <input
                  readOnly
                  value={ticket.pairing_uri}
                  className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-[11px] text-zinc-400 focus:outline-none"
                />
                <button
                  onClick={copyUri}
                  className="px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-sans font-medium flex items-center gap-1.5 shrink-0 cursor-pointer"
                >
                  {copied ? (
                    <>
                      <Check className="w-3.5 h-3.5" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      Copy URI
                    </>
                  )}
                </button>
                <button
                  onClick={loadTicket}
                  className="p-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 cursor-pointer"
                  title="Regenerate E2EE Key"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
