# Builds the Resource Center library migration from data/resource-research/*.json.
# Usage: python3 -I scripts/build-resource-library.py data/resource-research <out.sql>
# Only links confirmed on official agency sites are imported; unconfirmed ones are left out.
import json, glob, re, sys, hashlib
SP = sys.argv[1]; OUT = sys.argv[2]
NO_WAGE_TAX = {"AK","FL","NV","NH","SD","TN","TX","WA","WY"}
NO_SALES_TAX = {"AK","DE","MT","NH","OR"}
VALID = {"TAX_AGENCY","TAX_PORTAL","INDIVIDUAL_INCOME_TAX","REFUND_STATUS","BUSINESS_INCOME_TAX","SALES_USE_TAX","WITHHOLDING","UNEMPLOYMENT_TAX","BUSINESS_REGISTRY","ANNUAL_REPORT","BUSINESS_LICENSE","ALCOHOL_LICENSING","ALCOHOL_TAX","NONPROFIT_FORMATION","CHARITABLE_REGISTRATION","LOCAL_TAX_LICENSE","FEDERAL_TAX","FEDERAL_SBA","FEDERAL_SAM"}
rows, skipped = [], []
NAMES = {"AK":"Alaska","FL":"Florida","NV":"Nevada","NH":"New Hampshire","SD":"South Dakota","TN":"Tennessee","TX":"Texas","WA":"Washington","WY":"Wyoming","DE":"Delaware","MT":"Montana","OR":"Oregon"}
def known_note(st, cat):
    n = NAMES.get(st, st)
    if cat in ("INDIVIDUAL_INCOME_TAX","WITHHOLDING") and st in NO_WAGE_TAX:
        extra = {"WA": " Washington does have a capital gains excise tax on certain long-term gains.", "NH": " New Hampshire's Interest and Dividends Tax was repealed for periods beginning in 2025.", "TN": " Tennessee's Hall tax on investment income was fully repealed."}.get(st, "")
        return f"{n} doesn't tax individual wage income, so there's no state income tax return{' or employer income-tax withholding' if cat == 'WITHHOLDING' else ''}.{extra}"
    if cat == "SALES_USE_TAX" and st in NO_SALES_TAX:
        return "Alaska has no statewide sales tax; some cities and boroughs levy their own local sales tax." if st == "AK" else f"{n} has no statewide general sales tax."
    return None
files = sorted(glob.glob(f"{SP}/group*.json")) + [f"{SP}/federal-al.json"]
seen = set()
for f in files:
    try: data = json.load(open(f))
    except Exception as e: print("skip", f, e); continue
    for e in data:
        st, cat = e.get("state"), e.get("category")
        if cat not in VALID: skipped.append((st,cat,"bad category")); continue
        method = (e.get("method") or "none").lower()
        status = e.get("status")
        url = (e.get("url") or "").strip() or None
        if url and not url.startswith("https://"): url = None if not url.startswith("http://") else url.replace("http://","https://",1)
        kn = known_note(st, cat)
        if status == "NOT_APPLICABLE" and kn:
            e = {**e, "notes": kn, "purpose": kn, "agency": e.get("agency") or f"{NAMES.get(st, st)} tax agency"}
            method = "known fact"
        if status == "NOT_APPLICABLE":
            backed = method in ("fetched","official-result","in-text","known fact")
            known = (cat in ("INDIVIDUAL_INCOME_TAX","WITHHOLDING") and st in NO_WAGE_TAX) or (cat == "SALES_USE_TAX" and st in NO_SALES_TAX)
            if not (backed or known) or not (e.get("notes") or "").strip(): skipped.append((st,cat,"N/A unconfirmed")); continue
        else:
            if method not in ("fetched","official-result","in-text") or not url: skipped.append((st,cat,"unconfirmed")); continue
            if status not in ("VERIFIED","NEEDS_VERIFICATION"): status = "NEEDS_VERIFICATION"
        if not (e.get("purpose") or e.get("notes")): skipped.append((st,cat,"no purpose")); continue
        rows.append({"state": st, "county": e.get("county"), "city": e.get("city"), "category": cat, "title": e.get("title") or cat, "purpose": e.get("purpose") or e.get("notes") or "", "agency": e.get("agency") or "State agency", "url": url, "phone": e.get("phone"), "status": status, "method": method, "notes": e.get("notes")})
for st, agency, url, method, purpose in json.load(open(f"{SP}/refunds.json")):
    rows.append({"state": st, "county": None, "city": None, "category": "REFUND_STATUS", "title": "Where's my state refund?", "purpose": purpose, "agency": agency, "url": url, "phone": None, "status": "VERIFIED" if method == "official-result" and "homepage only" not in purpose else "NEEDS_VERIFICATION", "method": method, "notes": None})
for st in ["AK","FL","NV","SD","TN","TX","WA","WY","NH"]:
    rows.append({"state": st, "county": None, "city": None, "category": "REFUND_STATUS", "title": "State income tax refund", "purpose": "No state income tax refund tool.", "agency": "—", "url": None, "phone": None, "status": "NOT_APPLICABLE", "method": "known fact", "notes": f"{NAMES.get(st, st)} doesn't tax individual wage income, so there's no state income-tax refund to check. For a federal refund, use the IRS link."})
CLIENT_NOTES = {
    ("MT","BUSINESS_LICENSE"): "Montana has no general statewide business license; general business licenses come from cities and counties, and some industries need a state license.",
    ("KY","BUSINESS_LICENSE"): "Kentucky has no general statewide business license; many cities and counties require local business licenses, and certain business types need a special state license or permit.",
}
for r in rows:
    if (r["state"], r["category"]) in CLIENT_NOTES and r["status"] == "NOT_APPLICABLE":
        r["notes"] = CLIENT_NOTES[(r["state"], r["category"])]
def q(v): return "NULL" if v is None or v == "" else "'" + str(v).replace("'", "''") + "'"
out = ["-- Resource Center library (researched Oct 29, 2026). Only links confirmed on official agency sites;","-- unconfirmed items are left out so clients never see a guessed link. Admins edit these rows in the app.",""]
order = {}
for r in rows:
    key = (r["state"], r["category"]); order[key] = order.get(key, -1) + 1
    rid = "res_" + hashlib.sha1(f'{r["state"]}|{r["category"]}|{r["url"] or r["title"]}|{r.get("county")}|{r.get("city")}'.encode()).hexdigest()[:20]
    if rid in seen: continue
    seen.add(rid)
    lv = "'2026-10-29 12:00:00'" if r["status"] in ("VERIFIED","NOT_APPLICABLE") else "NULL"
    out.append(f'INSERT INTO "Resource" ("id","jurisdiction","county","city","category","title","purpose","agency","url","phone","status","verificationMethod","notes","lastVerifiedAt","sortOrder","updatedAt") VALUES ({q(rid)},{q(r["state"])},{q(r["county"])},{q(r["city"])},{q(r["category"])},{q(r["title"][:160])},{q(r["purpose"][:400])},{q(r["agency"][:160])},{q(r["url"])},{q(r["phone"])},{q(r["status"])},{q(r["method"])},{q(r["notes"])},{lv},{order[key]},CURRENT_TIMESTAMP) ON CONFLICT ("id") DO NOTHING;')
open(OUT,"w").write("\n".join(out)+"\n")
from collections import Counter
c = Counter((r["state"]) for r in rows)
print("rows", len(seen), "skipped", len(skipped))
print("states with rows:", len([s for s in c if s not in ("US",)]))
print(sorted(c.items()))
