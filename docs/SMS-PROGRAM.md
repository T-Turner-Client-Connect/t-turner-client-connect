# SMS program: consent, opt-out and Twilio setup

## Public pages (no login)

| Page | Path |
|---|---|
| SMS consent form ("Stay Connected with TTurner") | `/sms-consent` |
| Privacy Policy | `/privacy-policy` |
| Terms & Conditions | `/terms` |

Linked from every footer (staff workspace, client portal, public pages) and from the welcome, Staff
Login and Client Login pages. The platform is identified as "TTurner Client Connect, operated by
T. Turner & Associates, LLC". Business details live in `src/lib/business.ts`.

## How consent works in the app

- The form has two **separate, optional, unchecked** boxes: service messages and marketing messages.
  The Privacy Policy and Terms are linked beside them, not bundled into the consent.
- Each submission stores name, phone, which boxes were checked, the **exact wording shown**, a wording
  version (`SMS_CONSENT_VERSION`), the source page, the time, a keyed hash of the IP address (not the
  raw IP) and the browser user agent. Success is only shown after the database save commits.
- Permissions are kept in a per-phone ledger (`SmsConsentEvent`) by category (SERVICE / MARKETING).
  Matching client and contact records get the same history so staff see it on the client page.
  Unchecking a box later withdraws that category.
- Clients can also opt in or out of **service** texts on the portal **Account** page, using the same
  service wording.
- Imported contacts are never opted in.
- **Every text is checked on the server right before sending**: the category must be GRANTED and the
  number must not be opted out. Portal notifications need service consent; campaigns check service vs.
  marketing according to the campaign's purpose.
- **STOP** (STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE, OPTOUT): the number is opted out of
  all categories and added to the do-not-contact list. Staff can't override it. **START** is logged but
  does not restart texts. As the Terms say, people opt in again through the consent form, which then
  lifts the block. **HELP** returns the help message.
- Incoming texts from a number belonging to exactly one client go into that client's Conversations;
  others are listed under Settings → SMS consent & incoming texts.
- Webhooks only accept requests carrying a valid Twilio signature. Delivery receipts update each
  message's status (accepted → delivered / undelivered / failed). Nothing is marked delivered just
  because Twilio accepted it.

## Twilio console setup

1. **Messaging Service** → Integration → *Incoming Messages*: **Send a webhook**, Request URL
   `https://<your-site>/api/webhooks/twilio/inbound`, method **HTTP POST**. (The exact URL is shown
   under Settings → SMS consent & incoming texts once `APP_URL` is set.) Delivery status callbacks are
   attached to each message automatically.
2. **Messaging Service** → Opt-Out Management (**Advanced Opt-Out**). Keep it on and set:
   - HELP reply: `T. Turner & Associates (TTurner Client Connect): for help call 205-659-5448. Msg frequency varies. Msg & data rates may apply. Reply STOP to unsubscribe.`
   - STOP reply: `T. Turner & Associates: You are unsubscribed and will receive no further messages. To resume, opt in again at our SMS consent page.`
   Leave `SMS_KEYWORD_REPLIES=twilio` so the app doesn't send a second reply.
3. Netlify variables: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID`, `APP_URL`
   (must be the exact public address Twilio calls; the webhook signature depends on it).
4. Keep `LIVE_SENDING_ENABLED=false` and `NOTIFICATIONS_ENABLED=false` until a staff test number has
   opted in and a test text is confirmed delivered.

## Not yet configured or still to confirm

- **Business details to confirm**: office phone **205-659-5448** came from the owner; it appears nowhere
  else in the app or repository, so it wasn't independently verified. No mailing address or privacy
  email is set (`BUSINESS_MAILING_ADDRESS` is empty).
- **Effective date**: `LEGAL_EFFECTIVE_DATE` is October 29, 2026. Change it if the pages are first
  published later.
- **Campaign texting** is still locked. One-to-one texting from Conversations is not enabled yet.
- **Web-form verification**: the form doesn't send a confirmation text yet (double opt-in). Add one
  when live sending is enabled.
- **Policy review**: see the flags in the pull request. The policy text was published as drafted.
