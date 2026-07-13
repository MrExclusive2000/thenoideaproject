# Project Ideas — Decision Record

*Compiled 13 July 2026. This is the record of the full ideation funnel: what was considered, what the research showed, what was rejected and why, and what won.*

## The brief (as it evolved)

Starting constraints:

1. Hostable on **Pelican Panel via egg** (i.e. runs as a Docker container) — satisfied in the final plan by the self-hosted webstore.
2. **Income is the goal** — "the aim is MONEY", with proof, not vibes.
3. Genuinely new / not saturated.
4. **Marketable by a solo founder with no outbound sales** — no cold calls, no walk-in demos, no cold DMs. Marketplace distribution, organic content, and automation instead.
5. A **trademark-clear name** — the previous clothing brand died on a name conflict; never again.
6. Guides, automations, and AI built into the plan.
7. Final steer: **physical products people buy** — dropship / white-label / rebrand — not a software product.

## The funnel — everything considered and why it fell

### Round 1: gaming-adjacent software (rejected: saturated or off-brief)

| Idea | Why rejected |
|---|---|
| Pelican/Pterodactyl panel-management Discord bots | Already exist: PteroControl, Devactyl, PteroStats, Pelican-Keeper |
| Tebex-style game server webstores | Crowded: MineStore, LeaderOS, CraftingStore, VyHub |
| Pelican billing/provisioning suite | Paymenter and WHMCS modules already serve it |
| Merch → in-game rewards bridge | Genuine gap, but user steered away from gaming stores |

### Round 2: e-commerce/shipping software (rejected by user)

- **Self-hosted post-purchase suite** (branded order tracking + notifications; the AfterShip-alternative). Research confirmed a real gap — the entire category is metered SaaS with zero self-hosted competitors — but the user didn't connect with the idea.

### Round 3: service software (rejected: sales motion mismatch)

- **AI Front Desk** (missed-call-text-back for local businesses). Strongest raw money case (£100–300/mo per client, bleeding pain), but requires direct B2B selling — walk-ins, DMs, demos. User: "I don't think I can market/sell this." Correctly killed on founder-fit.
- **Brand Guard** (trademark watch for founders — inspired by the user's own story). Story-led content motion, but slow-burn revenue; user prioritised faster money.

### Round 4: marketplace-distributed software (strong finalists, superseded by the physical-product pivot)

Two deep-research agents each validated a finalist:

- **Thread Passport** — Shopify app for EU textile compliance (Digital Product Passports + France's Ecobalyse environmental score + GPSR data). Verified: six competing DPP apps, all launched within 7 months, **all with zero reviews**; France's third-party-scoring rule (from Oct 2026) creates fear-driven demand; a comparable GPSR-only app charges $15–29/mo with 27 five-star reviews. Conservative projection £1.8k/mo MRR at month 12.
- **MatchDay** — Discord-native tournament/league platform as a Pelican egg. Verified timing wave: Challonge's API went paid 6 July 2026 (breaking the free-bot ecosystem), Tourney Bot cut its free tier to 3 tournaments/8 players, Toornament paywalled at €19/tournament. Conservative ≈ £865/mo at month 12.

Both remain documented, viable software plays. The user then pivoted the brief to **physical products** — which better matches his actual skills (branding, design, product content) and history (clothing brand).

### Round 5: physical product niches (the final round)

A research agent scored candidate niches against six hard criteria: (1) provable UK marketplace demand, (2) white-label-friendly with low MOQs and a visible branding premium, (3) ≥50% white-label gross margin, (4) short-form-content-friendly, (5) not saturated / not regulation-heavy, (6) authentic fit with the founder's worlds (apparel/design + gaming).

| Candidate | Verdict | Killing reason |
|---|---|---|
| Gym straps / wrist wraps / lifting soft goods | ✗ | Saturated by entrenched specialists (Gymreapers, RDX) in a price war |
| Tech pouches / EDC organizers | ✗ | Etsy is handmade/leather-craft dominated; rebrands clash with Etsy originality rules; Peak Design owns premium mindshare |
| Gaming-room lighting / decor gadgets | ✗ | All electrical → UKCA/CE, WEEE, battery regs — the regulatory pain this plan avoids |
| Desk organisation / cable management | ✗ | Commodity plastic at sub-£10 price points; margins eaten by shipping |
| Headphone/controller stands, desk shelves | ✗ | Bulky/fragile freight; no demonstrated brand-premium gap |
| Generic loungewear, phone cases, water bottles | ✗ | Pre-excluded as saturated; nothing overturned that |
| **Blanket hoodies / wearable blankets** | **Runner-up** | Category proven at brand scale (The Oodie: A$600m+ cumulative sales; UK search +200%), Alibaba supply at $4–9.89/unit MOQ 50–100, ~55–60% white-label margins at £35–45 retail — but heavily Q4-seasonal, bulky units, and funded incumbents + supermarket clones crowd the mid-market. **Planned as the Q4 second product line under the same brand.** |
| **Custom-designed XL desk mats** | **WINNER** | See below |

## The winner: a design-led desk mat brand

**Why it won on the evidence:**

1. **Proven UK demand.** Amazon UK has a dedicated Desk Pads & Blotters best-seller category where top gaming desk pads show 4,000–8,000+ bought-in-past-month badges (search-indexed snapshots; re-verify quarterly). The global mouse pad/desk mat market is valued around $6.2bn (2025), driven by WFH and esports. Active Etsy markets exist for `desk_mat` and `gaming_desk_mat`.
2. **The widest generic→branded price gap of any niche tested.** Generic sublimation mats manufacture at **$0.24–$2.88/unit** (verified live on Alibaba, MOQs from 5 units), while design brands retail at **£25–35** (indie) up to **$80–170** (Grovemade). Branding *is* the margin — and branding is the founder's proven skill.
3. **~61% white-label gross margin** at £29 on TikTok Shop (full arithmetic in [`docs/BUSINESS-PLAN.md`](docs/BUSINESS-PLAN.md)).
4. **Zero-risk validation path.** Printful prints desk mats on demand at £7.50 base with no minimums — designs are proven with real sales before any stock is bought.
5. **Content-proven niche.** A KBDFans desk mat video hit 4M TikTok views in a month; desk-setup ASMR and unboxing formats are established; small studios report sell-outs from single viral videos. This is the founder's exact content skill set.
6. **Light compliance.** No UKCA/CE (non-electrical), no textile fibre labelling (rubber-backed mats fall outside the Textile Products Regulations) — simpler than the clothing brand was. GB product-safety traceability + a REACH supplier declaration cover it.
7. **Maximum authentic fit.** Printed textile design (apparel skills) × gaming/desk-setup culture (his world). All artwork original — no licensed characters, no IP minefield.

**The model in one line:** validate original designs with POD at £0 stock risk → white-label the proven winners at ~£5 landed → sell at £29–35 through Etsy + TikTok Shop (+ own store on the Pelican panel) → let TikTok Shop's open affiliate programme scale sales with no outreach → add blanket hoodies for Q4.

**Full sources** are cited inline in [`docs/BUSINESS-PLAN.md`](docs/BUSINESS-PLAN.md).
