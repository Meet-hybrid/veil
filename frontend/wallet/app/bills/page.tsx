'use client'

/**
 * Bills & airtime — the everyday-money surface from the `Veil Web` design.
 *
 * The naira conversion and bill-vending leg shipped on Linq (`POST /ngn/bills`
 * and `GET /ngn/bills/:orderId` in wraith; see `docs/NGN_RAILS.md`). Airtime
 * top-ups and bank cash-out (`/cashout`) are live today and share `@/lib/ngn`
 * with the rest of the web wallet. The remaining categories stay marked `Soon`
 * until their category-specific verification fields are wired — nothing here
 * invents balances, quotes, or purchase history.
 *
 * Like `app/cashout/page.tsx`, paying a bill on the web wallet reserves the
 * order first (`payBill`) to lock the rate and obtain the deposit address, and
 * then hands the exact locked amount to `/send` for passkey signing while
 * polling `getBillStatus` until the top-up settles or is refunded.
 */

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

import {
  Card,
  PageHeader,
  Pill,
  PrimaryAction,
  SectionLabel,
  Tag,
} from '@/components/ui/primitives'
import { ensureFeePayer } from '@/lib/feePayer'
import { getUsdcIssuer } from '@/lib/network'
import {
  getBillStatus,
  getCustomerRef,
  getCustomerStatus,
  getOnrampRate,
  isNairaKycMismatch,
  isNairaNetwork,
  isNairaVerified,
  payBill,
  setNairaVerified,
  type BillOrder,
  type NairaCoin,
} from '@/lib/ngn'

type Service = {
  id: string
  name: string
  sub: string
  icon: string
  tone: 'gold' | 'teal' | 'lilac'
  status: 'live' | 'soon'
  route?: string
}

export const SERVICES: Service[] = [
  { id: 'airtime', name: 'Airtime', sub: 'All networks', icon: '☎', tone: 'gold', status: 'live' },
  { id: 'data', name: 'Data', sub: 'Bundles', icon: '▦', tone: 'gold', status: 'soon' },
  { id: 'power', name: 'Power', sub: 'Prepaid units', icon: '⌁', tone: 'teal', status: 'soon' },
  { id: 'tv', name: 'TV', sub: 'DStv · GOtv', icon: '▤', tone: 'lilac', status: 'soon' },
  { id: 'water', name: 'Water', sub: 'State boards', icon: '◈', tone: 'teal', status: 'soon' },
  { id: 'transfer', name: 'Transfer', sub: 'To any bank', icon: '↗', tone: 'gold', status: 'live', route: '/cashout' },
  { id: 'betting', name: 'Betting', sub: 'Top up', icon: '◉', tone: 'lilac', status: 'soon' },
  { id: 'education', name: 'Education', sub: 'WAEC · JAMB', icon: '✎', tone: 'teal', status: 'soon' },
]

const TONE_FG = {
  gold: 'var(--gold)',
  teal: 'var(--teal)',
  lilac: 'var(--lilac)',
} as const

const PREFIXES: Record<string, string[]> = {
  MTN: ['0803', '0806', '0703', '0706', '0813', '0816', '0810', '0814', '0903', '0906', '0913', '0916'],
  AIRTEL: ['0802', '0808', '0708', '0812', '0701', '0902', '0901', '0904', '0907', '0912'],
  GLO: ['0805', '0807', '0705', '0815', '0811', '0905', '0915'],
  '9MOBILE': ['0809', '0818', '0817', '0909', '0908'],
}

const NETWORKS = Object.keys(PREFIXES)
const QUICK_AMOUNTS = [200, 500, 1000, 2000]
const COINS: { id: NairaCoin; label: string }[] = [
  { id: 'usdc', label: 'USDC' },
  { id: 'xlm', label: 'XLM' },
]

export function detectAirtimeNetwork(phone: string): string | null {
  const digits = phone.replace(/\D/g, '')
  if (digits.length < 4) return null
  const prefix = digits.slice(0, 4)
  for (const [network, list] of Object.entries(PREFIXES)) {
    if (list.includes(prefix)) return network
  }
  return null
}

type Step = 'form' | 'pay' | 'done' | 'failed'

export default function BillsPage() {
  const router = useRouter()

  const mainnetOnly = !isNairaNetwork()
  const [verified, setVerified] = useState<boolean | null>(null)
  const [mismatch, setMismatch] = useState(false)
  const [customerRef, setCustomerRef] = useState<string | null>(null)
  const [refundAddress, setRefundAddress] = useState<string | null>(null)

  const [provider, setProvider] = useState<string>('MTN')
  const [providerTouched, setProviderTouched] = useState(false)
  const [phone, setPhone] = useState('')
  const [amountNGN, setAmountNGN] = useState('')
  const [coin, setCoin] = useState<NairaCoin>('usdc')

  const [rate, setRate] = useState<number | null>(null)
  const [rateFailed, setRateFailed] = useState(false)
  const [step, setStep] = useState<Step>('form')
  const [order, setOrder] = useState<(BillOrder & { amountStableCoin: number; amountNgn: number }) | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const phoneDigits = phone.replace(/\D/g, '')
  const detected = detectAirtimeNetwork(phoneDigits)

  useEffect(() => {
    if (detected && !providerTouched) setProvider(detected)
  }, [detected, providerTouched])

  useEffect(() => {
    const local = isNairaVerified()
    setVerified(local)
    setMismatch(isNairaKycMismatch())
    const ref = getCustomerRef()
    setCustomerRef(ref)

    if (!local && ref) {
      void getCustomerStatus(ref)
        .then((status) => {
          if (status.verified) {
            setNairaVerified(true)
            setVerified(true)
          }
        })
        .catch(() => undefined)
    }

    void ensureFeePayer()
      .then((kp) => setRefundAddress(kp?.publicKey() ?? null))
      .catch(() => setRefundAddress(null))
  }, [])

  const loadRate = useCallback(() => {
    if (mainnetOnly) return () => undefined
    let cancelled = false
    setRate(null)
    setRateFailed(false)
    getOnrampRate(coin)
      .then((r) => {
        if (!cancelled) setRate(r)
      })
      .catch(() => {
        if (!cancelled) {
          setRate(null)
          setRateFailed(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [coin, mainnetOnly])

  useEffect(() => {
    return loadRate()
  }, [loadRate])

  // Poll the bill status once an order is reserved. A failed poll is never
  // treated as a failed payment — if the user has already sent the deposit,
  // telling them the top-up failed on a network blip would be false.
  useEffect(() => {
    if (!order || !customerRef || step !== 'pay') return
    const check = () => {
      void getBillStatus(customerRef, order.id)
        .then((s) => {
          if (/complete|success|delivered/i.test(s.status)) setStep('done')
          if (/fail|refund|revers/i.test(s.status)) setStep('failed')
        })
        .catch(() => undefined)
    }
    check()
    const id = setInterval(check, 10_000)
    return () => clearInterval(id)
  }, [order, customerRef, step])

  const ngn = Number(amountNGN.replace(/[^\d]/g, '')) || 0
  const phoneValid = phoneDigits.length === 11 && phoneDigits.startsWith('0')
  const estimated = rate && ngn > 0 ? ngn / rate : null

  const reserveAirtime = useCallback(async () => {
    if (!customerRef || !refundAddress || !phoneValid || !(ngn > 0)) return
    setBusy(true)
    setError(null)
    try {
      const fresh = await getOnrampRate(coin)
      setRate(fresh)
      const amountStableCoin = Number((ngn / fresh).toFixed(7))
      const created = await payBill({
        customerRef,
        billCategory: 'airtime',
        provider,
        customerId: phoneDigits,
        amountNgn: ngn,
        amountStableCoin,
        rate: fresh,
        coin,
        refundAddress,
      })
      setOrder({ ...created, amountStableCoin, amountNgn: ngn })
      setStep('pay')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reserve the airtime order.')
    } finally {
      setBusy(false)
    }
  }, [customerRef, refundAddress, phoneValid, ngn, coin, provider, phoneDigits])

  const copyDepositAddress = useCallback(async () => {
    if (!order) return
    await navigator.clipboard.writeText(order.wallet)
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }, [order])

  return (
    <>
      <PageHeader eyebrow="Everyday" title="Bills & airtime" />

      <div className="flex gap-5 mt-[26px] items-start max-xl:flex-col">
        <div className="flex-1 min-w-0 flex flex-col gap-5 w-full">
          <Card>
            <SectionLabel>Pay for</SectionLabel>
            <div className="grid grid-cols-4 max-md:grid-cols-2 gap-3 mt-[18px]">
              {SERVICES.map((s) => {
                const isLive = s.status === 'live'
                const commonClass =
                  'bg-[rgba(255,255,255,0.04)] border rounded-[18px] px-4 py-[18px] flex flex-col gap-[5px] text-left transition-colors'
                if (isLive) {
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => {
                        if (s.route) router.push(s.route)
                      }}
                      className={`${commonClass} border-[rgba(253,218,36,0.3)] hover:border-gold cursor-pointer`}
                    >
                      <div className="flex justify-between items-center w-full">
                        <span className="text-[17px]" style={{ color: TONE_FG[s.tone] }}>
                          {s.icon}
                        </span>
                        <Tag tone="gold">Live</Tag>
                      </div>
                      <div className="text-sm font-semibold mt-1 whitespace-nowrap text-off-white">
                        {s.name}
                      </div>
                      <div className="text-[11px] text-[rgba(246,247,248,0.55)] whitespace-nowrap">
                        {s.sub}
                      </div>
                    </button>
                  )
                }
                return (
                  <div
                    key={s.id}
                    aria-disabled="true"
                    title="Coming soon"
                    className={`${commonClass} border-border-dim opacity-60`}
                  >
                    <div className="flex justify-between items-center w-full">
                      <span className="text-[17px]" style={{ color: TONE_FG[s.tone] }}>
                        {s.icon}
                      </span>
                      <Tag tone="dim">Soon</Tag>
                    </div>
                    <div className="text-sm font-semibold mt-1 whitespace-nowrap">{s.name}</div>
                    <div className="text-[11px] text-[rgba(246,247,248,0.4)] whitespace-nowrap">
                      {s.sub}
                    </div>
                  </div>
                )
              })}
            </div>
          </Card>

          <Card>
            <SectionLabel>Scheduled</SectionLabel>
            <p className="text-[13px] text-[rgba(246,247,248,0.55)] leading-[1.7] mt-3">
              Recurring bills are not wired yet. When they ship, each run will build an unsigned
              transaction and wait for your passkey — nothing will ever be charged automatically.
            </p>
          </Card>
        </div>

        <div className="w-[420px] max-xl:w-full shrink-0 flex flex-col gap-5">
          {mainnetOnly && (
            <Card>
              <SectionLabel>Airtime · Mainnet only</SectionLabel>
              <p className="text-[15px] font-semibold text-off-white mt-3 mb-2">
                Switch to mainnet to buy airtime
              </p>
              <p className="text-[13px] leading-relaxed text-white/55">
                Top-ups are vended against real crypto on the naira rail, so this only works on
                mainnet — there is no test mode. Switch network in Settings, then come back.
              </p>
            </Card>
          )}

          {!mainnetOnly && mismatch && (
            <Card className="border-[rgba(220,38,38,0.35)]">
              <p className="text-[15px] font-semibold text-off-white mb-2">
                Your identity check needs support
              </p>
              <p className="text-[13px] leading-relaxed text-white/55 mb-3">
                Your NIN is verified against a different customer reference, so orders on this one
                are refused. Send this reference to support and they can re-bind it.
              </p>
              <p className="text-[12px] font-mono text-gold break-all">{customerRef ?? '—'}</p>
            </Card>
          )}

          {!mainnetOnly && verified === false && !mismatch && (
            <Card>
              <SectionLabel>Airtime</SectionLabel>
              <p className="text-[15px] font-semibold text-off-white mt-3 mb-2">
                Verify once first
              </p>
              <p className="text-[13px] leading-relaxed text-white/55 mb-5">
                Nigerian rules require a one-time identity check before you can pay bills on the
                naira rail. It takes a minute and you will not be asked again.
              </p>
              <PrimaryAction onClick={() => router.push('/verify?returnTo=/bills')}>
                Verify my identity
              </PrimaryAction>
            </Card>
          )}

          {!mainnetOnly && verified && !mismatch && step === 'form' && (
            <Card>
              <SectionLabel>Buy airtime</SectionLabel>

              <div className="flex flex-wrap gap-2 mt-4">
                {NETWORKS.map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => {
                      setProvider(n)
                      setProviderTouched(true)
                    }}
                    className={`px-3.5 py-2 rounded-pill text-[12px] border transition-colors ${
                      provider === n
                        ? 'bg-gold text-near-black border-gold font-semibold'
                        : 'border-border-dim text-white/60 hover:text-white/80'
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>

              <div className="mt-4">
                <label
                  htmlFor="airtime-phone"
                  className="block text-[11px] uppercase tracking-wider text-white/45 mb-1.5"
                >
                  Phone number
                </label>
                <input
                  id="airtime-phone"
                  inputMode="numeric"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value.replace(/[^\d]/g, '').slice(0, 11))}
                  placeholder="0803 512 4471"
                  className="w-full bg-surface-md border border-border-strong rounded-[14px] px-4 py-3 text-off-white font-mono text-[17px] outline-none focus:border-gold"
                />
                <p className="text-[12px] text-white/45 mt-1.5">
                  {detected
                    ? `${detected} number, detected from ${phoneDigits.slice(0, 4)}${
                        providerTouched && provider !== detected ? ` — sending to ${provider}` : ''
                      }`
                    : 'Numbers get ported, so check the network above matches.'}
                </p>
              </div>

              <div className="mt-4">
                <label
                  htmlFor="airtime-amount"
                  className="block text-[11px] uppercase tracking-wider text-white/45 mb-1.5"
                >
                  Amount (₦)
                </label>
                <input
                  id="airtime-amount"
                  inputMode="numeric"
                  value={amountNGN}
                  onChange={(e) => setAmountNGN(e.target.value.replace(/[^\d]/g, ''))}
                  placeholder="₦ amount"
                  className="w-full bg-surface-md border border-border-strong rounded-[14px] px-4 py-3 text-off-white text-[20px] outline-none focus:border-gold"
                />
                <div className="flex flex-wrap gap-2 mt-2.5">
                  {QUICK_AMOUNTS.map((q) => (
                    <button
                      key={q}
                      type="button"
                      onClick={() => setAmountNGN(String(q))}
                      className="px-3 py-1.5 rounded-pill text-[12px] border border-border-dim text-white/70 hover:text-off-white"
                    >
                      ₦{q.toLocaleString('en-NG')}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex gap-2 mt-4">
                {COINS.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setCoin(c.id)}
                    className={`flex-1 py-2 rounded-pill text-[13px] border transition-colors ${
                      coin === c.id
                        ? 'bg-gold text-near-black border-gold font-semibold'
                        : 'border-border-dim text-white/60 hover:text-white/80'
                    }`}
                  >
                    {c.label}
                  </button>
                ))}
              </div>

              <p className="text-[13px] text-white/50 mt-3">
                {rate !== null
                  ? `Costs ≈ ${
                      estimated ? estimated.toFixed(coin === 'xlm' ? 4 : 2) : '0.00'
                    } ${coin.toUpperCase()} @ ₦${rate.toLocaleString('en-NG')} / ${coin.toUpperCase()}`
                  : rateFailed
                    ? 'Rate unavailable right now.'
                    : 'Fetching the current rate…'}
              </p>
              {rateFailed && (
                <button
                  type="button"
                  onClick={() => loadRate()}
                  className="text-[12px] text-gold underline mt-1"
                >
                  Try again
                </button>
              )}

              {!refundAddress && (
                <p className="text-[12px] text-white/40 mt-2">
                  Setting up the refund account for this wallet…
                </p>
              )}
              {error && <p className="text-[13px] text-[rgba(220,38,38,0.9)] mt-3">{error}</p>}

              <div className="mt-6">
                <PrimaryAction
                  disabled={busy || !phoneValid || !(ngn > 0) || rate === null || !refundAddress}
                  onClick={() => void reserveAirtime()}
                >
                  {busy ? 'Reserving order…' : 'Continue'}
                </PrimaryAction>
              </div>
            </Card>
          )}

          {!mainnetOnly && step === 'pay' && order && (
            <Card>
              <SectionLabel>Send deposit</SectionLabel>
              <p className="text-[13px] leading-relaxed text-white/55 mt-3 mb-4">
                Send the exact amount below to complete your ₦
                {order.amountNgn.toLocaleString('en-NG')} {provider} top-up to {phoneDigits}. If{' '}
                {provider} cannot complete the top-up, the full amount is refunded to your wallet.
              </p>
              <Detail label="Network" value={provider} />
              <Detail label="Phone" value={phoneDigits} mono />
              <Detail label="Airtime" value={`₦${order.amountNgn.toLocaleString('en-NG')}`} />
              <Detail
                label="You send"
                value={`${order.amountStableCoin} ${coin.toUpperCase()}`}
                mono
              />
              <Detail label="Deposit address" value={order.wallet} mono />

              <div className="flex gap-2.5 mt-5">
                <Pill onClick={() => void copyDepositAddress()}>
                  {copied ? 'Copied' : 'Copy address'}
                </Pill>
                <PrimaryAction
                  onClick={() => {
                    const assetParam =
                      coin === 'usdc'
                        ? `&asset=USDC&issuer=${encodeURIComponent(getUsdcIssuer())}`
                        : '&asset=XLM'
                    router.push(
                      `/send?to=${encodeURIComponent(order.wallet)}&amount=${order.amountStableCoin}${assetParam}`,
                    )
                  }}
                >
                  Pay from wallet
                </PrimaryAction>
              </div>
            </Card>
          )}

          {!mainnetOnly && step === 'done' && order && (
            <Card>
              <SectionLabel tone="teal">Airtime sent</SectionLabel>
              <p className="text-[15px] font-semibold text-off-white mt-3 mb-2">
                ₦{order.amountNgn.toLocaleString('en-NG')} is on {phoneDigits}
              </p>
              <p className="text-[13px] leading-relaxed text-white/55 mb-5">
                It usually shows on the phone within a minute.
              </p>
              <PrimaryAction
                onClick={() => {
                  setStep('form')
                  setAmountNGN('')
                  setOrder(null)
                }}
              >
                Buy again
              </PrimaryAction>
            </Card>
          )}

          {!mainnetOnly && step === 'failed' && order && (
            <Card>
              <SectionLabel>Payment failed</SectionLabel>
              <p className="text-[15px] font-semibold text-off-white mt-3 mb-2">
                Refund on its way back
              </p>
              <p className="text-[13px] leading-relaxed text-white/55 mb-5">
                {provider} did not complete the top-up. Your {order.amountStableCoin}{' '}
                {coin.toUpperCase()} is being returned to your wallet.
              </p>
              <PrimaryAction
                onClick={() => {
                  setStep('form')
                  setOrder(null)
                  setError(null)
                }}
              >
                Try again
              </PrimaryAction>
            </Card>
          )}
        </div>
      </div>
    </>
  )
}

function Detail({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between items-center gap-4 py-[10px] border-b border-border-dim last:border-b-0">
      <span className="text-[13px] text-white/45">{label}</span>
      <span
        className={`text-[14px] text-off-white text-right break-all ${mono ? 'font-mono tracking-wide' : ''}`}
      >
        {value}
      </span>
    </div>
  )
}
