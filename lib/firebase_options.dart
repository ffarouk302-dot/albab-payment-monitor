// Firebase options for the standalone com.albab.paymentmonitor Android app.
// ignore_for_file: type=lint
import 'package:firebase_core/firebase_core.dart' show FirebaseOptions;
import 'package:flutter/foundation.dart'
    show defaultTargetPlatform, kIsWeb, TargetPlatform;

class DefaultFirebaseOptions {
  static FirebaseOptions get currentPlatform {
    if (kIsWeb) {
      throw UnsupportedError('The payment monitor supports Android only.');
    }
    switch (defaultTargetPlatform) {
      case TargetPlatform.android:
        return android;
      default:
        throw UnsupportedError('The payment monitor supports Android only.');
    }
  }

  static const FirebaseOptions android = FirebaseOptions(
    apiKey: 'AIzaSyD9FEwtKau06MVl30MZbVKs8DVpLnW7f7w',
    appId: '1:1001142117670:android:46bde201630fc93b39cde7',
    messagingSenderId: '1001142117670',
    projectId: 'albab-delivery',
    databaseURL:
        'https://albab-delivery-default-rtdb.europe-west1.firebasedatabase.app',
    storageBucket: 'albab-delivery.firebasestorage.app',
  );
}
