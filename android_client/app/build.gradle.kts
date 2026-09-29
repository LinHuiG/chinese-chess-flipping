plugins { id("com.android.application") }

android {
    namespace = "com.chessflipping.client"
    compileSdk = 37
    defaultConfig {
        applicationId = "com.chessflipping.client"
        minSdk = 26
        targetSdk = 37
        versionCode = 8
        versionName = "0.6.1"
        testInstrumentationRunner = "com.chessflipping.client.PresentationChecks"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    // Actions 使用固定签名；密钥和密码只从环境读取，不写入仓库。
    System.getenv("APK_KEYSTORE")?.takeIf { it.isNotBlank() }?.let { path ->
        signingConfigs.create("distribution") {
            storeFile = file(path)
            storePassword = System.getenv("APK_STORE_PASSWORD")
            keyAlias = System.getenv("APK_KEY_ALIAS")
            keyPassword = System.getenv("APK_KEY_PASSWORD")
        }
        buildTypes.getByName("release").signingConfig = signingConfigs.getByName("distribution")
    }
}

dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("androidx.core:core:1.15.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
