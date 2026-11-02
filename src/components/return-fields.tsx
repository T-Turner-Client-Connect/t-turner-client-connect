import { Field } from "@/components/ui";

const STATES = "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" ");

/** Client/business, tax year, return type, federal/state and original/amended — a return's own fields (never a bookkeeping month). */
export function ReturnFields({ year, type, clients, clientId }: { year?: number | null; type?: string | null; clients?: { id: string; name: string }[]; clientId?: string | null }) {
  const thisYear = new Date().getFullYear();
  return (
    <>
      {clients && (
        <Field label="Client / business">
          <select className="input" name="clientId" required defaultValue={clientId ?? ""}>
            <option value="">Choose — required</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
      )}
      <Field label="Tax year">
        <select className="input" name="taxYear" required defaultValue={year ?? ""}>
          <option value="">Choose…</option>
          {Array.from({ length: 8 }, (_, i) => thisYear - i).map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
      </Field>
      <Field label="Return type"><input className="input" name="returnType" required defaultValue={type ?? ""} placeholder="1040, 1120-S, 1065, 990, 40…" /></Field>
      <Field label="Federal or state">
        <select className="input" name="jurisdiction" required defaultValue="">
          <option value="">Choose…</option>
          <option value="FEDERAL">Federal</option>
          {STATES.map((s) => <option key={s} value={s}>{s} (state)</option>)}
        </select>
      </Field>
      <Field label="Original or amended">
        <select className="input" name="filingType" defaultValue="ORIGINAL"><option value="ORIGINAL">Original</option><option value="AMENDED">Amended</option></select>
      </Field>
    </>
  );
}
