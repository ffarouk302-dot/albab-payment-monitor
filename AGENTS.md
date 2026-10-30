# Albab Payment Monitor Repository Guidelines

## Source boundary

This repository is the only Flutter source and build root for the payment
monitor Android application:

- Project root: `D:\\albab-payment-monitor`.
- Entry point: `lib/main.dart`.
- Package: `com.albab.paymentmonitor`.
- Android label: `مراقب الدفع`.
- Current version: `1.0.8+9` in `pubspec.yaml`.
- APK output: `build/app/outputs/flutter-apk/app-release.apk`.

The delivery application lives separately at
`D:\\food-delivery-app-main\\food-delivery-app-main`. It is not a flavor,
target, dependency, or source folder in this repository. Do not copy delivery
code into this project, and do not build the delivery APK from here.

## Build and verification

Run these commands from `D:\\albab-payment-monitor`:

~~~powershell
flutter pub get
flutter analyze --no-pub
flutter test --no-pub
flutter build apk --release --target lib/main.dart --no-pub
~~~

Verify the generated APK before handing it off:

~~~powershell
aapt dump badging build/app/outputs/flutter-apk/app-release.apk
~~~

The output must show package `com.albab.paymentmonitor`, version `1.0.8`,
version code `9`, and application label `مراقب الدفع`. If it shows
`com.albab.delivery` or `AlbabDeliveryApp`, the wrong project or source was
built and the APK must not be distributed.

The last full validation on 2026-10-30 passed `flutter analyze`, all six
monitor tests, and the package/version/payload checks above.

## Project map

- `lib/bootstrap.dart`: Firebase initialization and monitor startup.
- `lib/features/payment_monitor/`: monitor Cubit, parser, API, UI, and SMS
  channel bridge.
- `android/app/src/main/AndroidManifest.xml`: monitor permissions, receiver,
  and foreground service declarations.
- `android/app/src/main/kotlin/com/albab/paymentmonitor/`: monitor activity,
  SMS receiver, and background service.
- `android/app/google-services.json`: public Firebase Android client config
  for `com.albab.paymentmonitor`.
- `backend/supabase/functions/payment-monitor/index.ts`: authenticated
  payment monitor Edge Function source.
- `backend/supabase/functions/_shared/firebase.ts` and `http.ts`: helpers
  required by that Edge Function.
- `test/features/payment_monitor/`: parser and history summary tests.

## Device approval lifecycle

- A new installation signs in with the existing monitor account password and
  sends a random installation `deviceId` to the `payment-monitor` function.
- The function creates `paymentMonitorDevices/{deviceId}` with status
  `pending`. It must not activate SMS monitoring or process payments while the
  device is pending, rejected, or revoked.
- The delivery app administrator reviews the request from its dedicated admin
  page. Valid states are `pending`, `approved`, `rejected`, and `revoked`.
- After approval, the monitor calls `activateDevice`. The server makes that
  device active and revokes the previous active device for this account.
- The server remains the authority for device access and all payment decisions.
  Never auto-approve a new installation or trust a local device flag alone.
- The device record contains operational metadata such as model, Android
  version, app version, request time, and last seen time. It contains no
  payment secret or service-account credential.

## Backend and financial boundaries

The monitor uses the existing `albab-delivery` Firebase project and the
authenticated Supabase `payment-monitor` function. It shares backend data and
contracts with the delivery application, but all payment matching and
financial decisions remain server-owned.

- Keep the monitor Firebase package registration and `google-services.json`
  aligned with `com.albab.paymentmonitor`.
- Keep the enforced wallet and monitor authentication contract in the Edge
  Function and app configuration consistent.
- Never approve a payment using a local amount or sender check alone.
- Never put Firebase service-account JSON, Supabase service-role keys,
  signing passwords, private keys, or other server secrets in this repository
  or APK.
- Deploy the Edge Function only after explicit approval for that backend
  resource. Building the APK does not deploy backend code.

## Archive boundary

`D:\\albab_archive\\albab-payment-monitor-from-main-20261030` contains old
rollback copies from the separation. It is not referenced by this repository,
is not needed for `flutter pub get`, analysis, tests, or builds, and may be
deleted when rollback copies are no longer needed.

## Git hygiene

The `.gitignore` excludes `build/`, APK/AAB files, signing material,
`local.properties`, and private environment files. Keep those rules in place.
Before pushing, check:

~~~powershell
git status --short
git diff --check
git ls-tree -r HEAD --name-only
~~~

The GitHub repository is
`https://github.com/ffarouk302-dot/albab-payment-monitor`.
The current APK source is the local project tree above; update the version in
`pubspec.yaml` before the next monitor release and rebuild from this root.
