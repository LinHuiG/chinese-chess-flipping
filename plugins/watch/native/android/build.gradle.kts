plugins { id("com.android.application") }
android {
    namespace = "com.cyberroom.watch.v101"
    compileSdk = 37
    defaultConfig {
        applicationId = "com.cyberroom.watch.v101"
        minSdk = 26
        targetSdk = 37
        versionCode = 1
        versionName = "1.0.0"
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    System.getenv("APK_KEYSTORE")?.takeIf { it.isNotBlank() }?.let { path ->
        signingConfigs.create("distribution") {
            storeFile = file(path); storePassword = System.getenv("APK_STORE_PASSWORD")
            keyAlias = System.getenv("APK_KEY_ALIAS"); keyPassword = System.getenv("APK_KEY_PASSWORD")
        }
        buildTypes.getByName("release").signingConfig = signingConfigs.getByName("distribution")
    }
}
dependencies {
    implementation(project(":plugin_api"))
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("androidx.media3:media3-exoplayer:1.8.0")
    implementation("androidx.media3:media3-exoplayer-hls:1.8.0")
    implementation("androidx.media3:media3-ui:1.8.0")
    implementation("androidx.media3:media3-datasource-okhttp:1.8.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
