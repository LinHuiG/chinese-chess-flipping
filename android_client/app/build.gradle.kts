import org.gradle.api.tasks.testing.Test

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

// CI 分开复用客户端检查和两端互通结果；普通本地测试仍执行全部用例。
tasks.withType<Test>().configureEach {
    when (providers.gradleProperty("chessTestSuite").orNull) {
        "client" -> filter.excludeTestsMatching("com.chessflipping.client.TransportV2Test")
        "interop" -> {
            filter.includeTestsMatching("com.chessflipping.client.TransportV2Test")
            // 服务端属于外部进程，Gradle 的 Java 输入缓存无法反映它的变化。
            outputs.upToDateWhen { false }
            outputs.cacheIf { false }
            doFirst {
                require(!System.getenv("CHESS_TEST_TCP_PORT").isNullOrBlank()
                    && !System.getenv("CHESS_TEST_HTTP_PORT").isNullOrBlank()) {
                    "Interop tests require CHESS_TEST_TCP_PORT and CHESS_TEST_HTTP_PORT"
                }
            }
        }
    }
}
