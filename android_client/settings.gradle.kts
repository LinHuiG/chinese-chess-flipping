pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories { google(); mavenCentral() }
}
rootProject.name = "ChessFlipping"
include(":app")
include(":plugin_api", ":watch_extension")
project(":plugin_api").projectDir = file("../plugin_sdk/native/android")
project(":watch_extension").projectDir = file("../plugins/watch/native/android")
