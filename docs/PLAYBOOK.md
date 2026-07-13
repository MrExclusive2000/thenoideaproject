# Playbook — Step-by-Step Execution Guides

*Written so each step is doable by one person with no prior e-commerce ops experience. Work top to bottom; each section ends with a "done when" check.*

## 1. Set up the sales channels (week 1)

### Etsy shop
1. Create a shop at etsy.com/sell — choose the cleared brand name (see `BRAND.md`; do NOT open the shop before the name is cleared).
2. In shop settings, add **production partners**: Printful (and later the Alibaba manufacturer). Etsy requires disclosure that a partner manufactures your designs — the listing category is "designed by a seller". Tick the partner on every listing.
3. Read the live [production partner policy](https://help.etsy.com/hc/en-us/articles/360000336547-Working-with-Production-Partners-on-Etsy) when opening the shop (it blocks bots, so this doc can't quote it verbatim).
4. Set shop policies: 14-day returns, dispatch times (Printful's SLA for phase 1), GB-only shipping initially (see compliance §7 of the business plan).

**Done when:** shop live with policies, partner disclosure configured, payment/billing verified.

### TikTok Shop UK seller account
1. Register at [seller-uk.tiktok.com](https://seller-uk.tiktok.com) (needs proof of ID + UK bank).
2. **Immediately disable Smart Promotions** (Seller Center → Marketing). It auto-enrols many accounts at up to 3.5–4.5% of GMV; this plan runs organic only.
3. Note the flat 9% commission in your pricing sheet.
4. Link the brand's TikTok account so videos can tag products directly.

**Done when:** account approved, Smart Promotions off, first product taggable.

## 2. The 10-design validation sprint (weeks 1–4)

Goal: find 2 winning designs with zero stock risk.

1. **Design brief (your craft):** 10 original mats, 900×400mm print area. Directions that demonstrably sell without touching anyone's IP: abstract gradients/dusk palettes, typographic/streetwear graphics, Japanese-inspired *original* motifs (no anime characters), topographic/blueprint lines, brutalist grids. Keep 2–3 colourways per design family so winners can expand.
2. **Hard IP rule:** nothing referencing games, anime, films, logos, fonts you don't have licences for. Original vector art only. (This rule is the lesson of the last brand, made structural.)
3. Upload each design to **Printful** (£7.50 base desk mat — ⚠ confirm exact size/shipping in the dashboard first) and connect Printful → Etsy and Printful → TikTok Shop so orders auto-fulfil with no touch.
4. **Order 2–3 physical samples of your favourites** (~£30) — you need them in hand for photography, quality judgement, and content.
5. List all 10 on Etsy at £24.99 with SEO-optimised titles (see `MARKETING.md` §2) and on TikTok Shop.
6. Post 3–5 short videos per week (formats in `MARKETING.md` §1) tagging the products.
7. **Read the data weekly:** Etsy search visits + favourites + conversion; TikTok video saves/shares; actual sales. A "winner" = repeat organic sales from more than one traffic source, or any design with ≥3× the engagement of the pack.

**Done when:** ≥2 designs show winner signal, or (if none do after 4 weeks) a second sprint of 10 designs informed by the data.

## 3. Choosing white-label winners (month 2–3)

Promote a design from POD to a 100-unit white-label batch when:
- It has sold ≥15–20 units POD across channels, **or** produced a content spike with sustained sell-through, **and**
- Margin math holds at £29–35 retail (see business plan §2), **and**
- You'd happily post it on your own desk — brand coherence matters more than one-off spikes.

## 4. Placing the first Alibaba order safely (month 3)

1. Shortlist 2–3 suppliers from the table in `BUSINESS-PLAN.md` §3 (start with Kunshan Standard Gifts — MOQ 5 — for a cross-supplier sample round).
2. Message each: confirm 900×400×4mm stitched-edge sublimation mat, your artwork file spec (they'll send a template), unit price at 100/250/500, **custom packaging** option (Yiwu JC offers it), production lead time, and a **REACH test report / declaration covering phthalates, azo dyes, PAHs** (compliance §7.2).
3. Order paid samples from 2 suppliers (~£20–40 total). Judge: print vibrancy vs your POD samples, edge stitching, rubber smell (a strong smell = cheap compound = returns), packaging quality.
4. Pay only via **Alibaba Trade Assurance** (never bank transfer). Get the freight quote at checkout — air-consolidated for the first batch; ⚠ replace the plan's £2.20/unit freight estimate with this real quote and re-run the margin table before confirming.
5. First order: **100 units of 1 design** (~£300–500 all-in). Have them print your traceability info (brand, UK contact address, batch ref) on the packaging sleeve.
6. While it ships (~3–4 weeks total): shoot the launch content batch with your POD sample.

**Done when:** stock lands, QC-checked (unroll 10 random units), listed at £29 on both channels, POD listing for that design retired.

## 5. Packaging & branding spec

- Ship in a rigid postal tube (~£0.60 with insert) — unboxing is a content format, make the tube part of the brand (kraft + one-colour logo print is cheap and looks premium).
- Insert card: thank-you + QR to the own store (repeat purchases at 67% margin) + care instructions + batch/traceability info.
- Wrap the mat in tissue with a sticker seal. Total insert cost pennies; perceived value large.

## 6. Automation stack (add only when the trigger fires)

| Tool | Job | Cost | Add when |
|---|---|---|---|
| Printful native integrations | POD orders auto-route to production (Etsy/TikTok/WooCommerce) | Free | Day 1 |
| [Base.com (BaseLinker)](https://base.com/en-US/pricing/) | One dashboard syncing listings/orders/stock across Etsy, TikTok, eBay, Amazon, own store | **Free ≤100 orders/mo**, then $19+/mo | When channel #3 goes live |
| [AutoDS](https://www.capterra.com/p/210453/AutoDS/) | Dropship price/stock monitoring, auto-ordering, AI titles | from $19.90/mo (⚠ beware annual-billing default) | Only if CJ/Avasam dropship SKUs are added |
| [EverBee](https://everbee.io/) / eRank | Etsy keyword + revenue research | Free–$30/mo | Week 1 (free tier) |
| Canva Pro + an AI assistant | Mockups, listing copy, content scripts, customer-service templates | ~£20–30/mo total | Day 1 |
| ~~Linnworks~~ | Full ERP | ~$4k/yr | **Don't** — overkill below ~£20k/mo |

## 7. AI workflows (use them, don't outsource judgement to them)

- **Design ideation:** generate mood boards and composition variants from your art direction; you finish every design by hand — AI output style-drifts and can echo copyrighted art, so it never ships raw. Check AI-assisted work extra carefully against the IP rule.
- **Listing SEO:** draft 3 title/tag variants per listing from EverBee keyword data; A/B across similar listings.
- **Content scripting:** turn each design's story into 5 hook variants; batch-record.
- **Customer service:** template replies for the 6 standard cases (where's my order / return / customs / damaged / wholesale enquiry / commission request). Personalise before sending.
- **Weekly ops review:** paste the week's numbers (visits, favourites, conversion, per-design sales) into your AI assistant with the question "which design gets the next batch and why?" — it's a good analyst; you stay the decision-maker.
