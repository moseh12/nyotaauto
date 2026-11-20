# Nyota Fund notification bot

Standalone Node.js (Node 20+) bot that sends Firebase HTTP v1 topic notifications to opted-in Nyota Fund Android users. It does not inspect loan applications, verify payments, or modify Laravel.

## Files

- `bot.js`: rotation, schedule checks, Google OAuth, Firebase HTTP v1
- `apps.json`: app/topic, Nairobi timezone, quiet hours, rate limits
- `messages.json`: promotional messages (no invented approvals)
- `state.json`: last sent message, daily count, timestamp
- `package.json`: Node metadata; no npm dependencies
- `.github/workflows/notifications.yml`: five-minute cron and manual test

## 1. Firebase credentials

In Firebase Console > Project settings > Service accounts, generate a service-account JSON key for the SAME Firebase project as the Flutter app. Ensure Firebase Cloud Messaging API (HTTP v1) is enabled in the associated Google Cloud project.

In the GitHub repository go to Settings > Secrets and variables > Actions > New repository secret.

Name: `FCM_SERVICE_ACCOUNTS`

Value: a JSON object mapping app ID to the complete Firebase service-account JSON, for example:

```json
{
  "nyotafund": {
    "type": "service_account",
    "project_id": "YOUR_FIREBASE_PROJECT_ID",
    "private_key_id": "...",
    "private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
    "client_email": "firebase-adminsdk-...@YOUR_FIREBASE_PROJECT_ID.iam.gserviceaccount.com",
    "client_id": "...",
    "token_uri": "https://oauth2.googleapis.com/token"
  }
}
```

Use your real complete JSON key inside the `nyotafund` object. Never commit it. If your repository is public, restrict who can trigger workflows.

## 2. Flutter integration

Your app already subscribes to `nyotafund_users`. Only subscribe users who opted in to marketing notifications, and provide an unsubscribe control:

```dart
await FirebaseMessaging.instance.subscribeToTopic('nyotafund_users');
await FirebaseMessaging.instance.unsubscribeFromTopic('nyotafund_users');
```

Android 13+ requires `POST_NOTIFICATIONS` permission in the manifest and runtime notification permission. For foreground messages, use your `FirebaseMessaging.onMessage` listener to show a local notification. For background/terminated delivery, Firebase notification payloads are displayed by Android when permitted (not guaranteed, especially if the app is force-stopped).

Create the Android notification channel `nyota_fund_alerts` in your Flutter startup. The channel ID must match `apps.json`.

Cancel only the old WorkManager promotional task if it is still active:

```dart
await Workmanager().cancelByUniqueName('nyota_15min_tickernow');
```

## 3. GitHub setup

1. Create a GitHub repository and upload the full folder, including `.github/workflows/notifications.yml`.
2. Set the default branch (usually `main`). GitHub scheduled workflows run from the default branch.
3. Add the `FCM_SERVICE_ACCOUNTS` secret as described above.
4. In Settings > Actions > General > Workflow permissions, allow **Read and write permissions** so the workflow can commit `state.json`.
5. In Actions > Nyota Fund Notifications > Run workflow, choose `test`, and uncheck `dry_run` to send a real test push.
6. Review Actions logs and test on a physical Android device.

GitHub Actions cron `*/5 * * * *` requests a run every five minutes; GitHub can delay or skip runs, particularly under load. FCM delivery itself is not guaranteed at an exact minute.

## 4. Scheduling and limits

The workflow **checks** every five minutes. As requested, the default configuration permits **up to 156 promotional messages per Nairobi day**, between 08:00 and 20:59, at least five minutes apart. **This is extremely frequent and not recommended**: use only for users who have explicitly agreed to this frequency. For normal production use, set `maxPromotionsPerDay` to `2` and `minimumMinutesBetweenPromotions` to `360` (six hours).

Configuration is in `apps.json`:

- `minimumMinutesBetweenPromotions`: minimum interval, minutes
- `maxPromotionsPerDay`: daily limit
- `quietHours`: local Nairobi time
- `firstMessageId`: first message to send

The current configuration requests delivery every five minutes during daytime, but GitHub Actions can delay/skip scheduled runs and Firebase does not guarantee exact delivery. High-frequency financial advertising can cause complaints, opt-outs, and platform policy problems. Do not deploy this frequency without explicit, informed consent.

For local dry-run testing:

```bash
DRY_RUN=1 FORCE=1 node bot.js
```

For a real local test, set `FCM_SERVICE_ACCOUNTS` in your shell and run `MODE=test node bot.js`. `MODE=test` sends only a neutral test push; it does not update `state.json`.

## 5. Message content and compliance

Only announce real approvals, specific amounts, customer stories, or M-Pesa disbursements when they are verified and consented to. Do not promise instant approval or guaranteed funding. Make financial product terms and fees clear in the app. Marketing notification consent should be separate from transactional alerts.

## 6. Troubleshooting

- `FCM_SERVICE_ACCOUNTS missing`: verify the GitHub secret name and JSON object key `nyotafund`.
- FCM 403: verify the service account, project ID, and Firebase Cloud Messaging API permissions.
- FCM accepted but no phone alert: verify Firebase project match, topic subscription, notification permission, Android channel, and battery restrictions.
- Duplicate alerts: remove the previous WorkManager promo task and avoid running multiple bots against the same topic.
- No scheduled workflow: ensure workflow is on the default branch, Actions are enabled, and scheduled workflows have not been disabled after repository inactivity.
- State commits fail: allow Actions write permissions and check branch protection. Without persisted state, daily limits and rotation will reset on each fresh runner.
