# Albab Payment Monitor

Standalone Android companion for monitoring Vodafone Cash payment SMS events.

This repository is intentionally separate from the customer/restaurant/rider
delivery application. It has one Flutter entry point only:

```text
lib/main.dart
```

The Android application ID is `com.albab.paymentmonitor`, version `1.0.7+8`,
and it uses the existing Albab Firebase project plus the authenticated
Supabase `payment-monitor` function. The monitor shares backend data and
contracts with the delivery system, but it does not share the delivery app
entry point, Android flavor, source tree, or build output.

## Build

Run from this repository root:

```powershell
flutter pub get
flutter analyze --no-pub
flutter build apk --release --target lib/main.dart --no-pub
```

The APK is written to:

```text
build/app/outputs/flutter-apk/app-release.apk
```

Before distributing an APK, verify its package with Android build tools:

```powershell
aapt dump badging build/app/outputs/flutter-apk/app-release.apk
```

The output must contain `com.albab.paymentmonitor` and `مراقب الدفع`.
