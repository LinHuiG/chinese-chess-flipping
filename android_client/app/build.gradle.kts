plugins { id("com.android.application") }

android {
    namespace = "com.chessflipping.client"
    compileSdk = 37
    defaultConfig {
        applicationId = "com.chessflipping.client"
        minSdk = 26
        targetSdk = 37
        versionCode = 4
        versionName = "0.4.0"
        testInstrumentationRunner = "com.chessflipping.client.PresentationChecks"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies { implementation("com.squareup.okhttp3:okhttp:4.12.0") }
