/**
 * Writes Stor.xcodeproj into the tenant's `.apple-build/project/`: the iOS app's Xcode project, from the
 * Swift files in this package (`swift/Shared` and `swift/iOS`, referenced by absolute path). The project
 * is generated, so adding a Swift file needs no project edit. Everything that differs per site (bundle id,
 * version, team, icon, Info.plist) lives in `.apple-build/project/Generated`, written by ios.ts.
 *
 * The Mac app does not use Xcode: mac.ts builds it with swiftc.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { PROJECT_ROOT, SWIFT_DIRECTORY } from "./site.js";

export const PROJECT_DIRECTORY = path.join(PROJECT_ROOT, "Stor.xcodeproj");
export const SCHEME = "Stor iOS";
export const PRODUCT = "Stor.app";
const DEPLOYMENT_TARGET = "17.0";

/** Xcode wants 24 hex digits; derive them from a name so the project is the same every time. */
function id(name: string): string {
    return createHash("sha1").update(`stor-apple:${name}`).digest("hex").slice(0, 24).toUpperCase();
}

const quote = (value: string) => (/^[A-Za-z0-9_./]+$/.test(value) ? value : `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`);

interface Settings { [key: string]: string | string[] }

function settingsBlock(settings: Settings, indent: string): string {
    return Object.entries(settings)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) =>
            Array.isArray(value)
                ? `${indent}${key} = (\n${value.map((item) => `${indent}\t${quote(item)},`).join("\n")}\n${indent});`
                : `${indent}${key} = ${quote(value)};`,
        )
        .join("\n");
}

function swiftFiles(directory: string): string[] {
    return readdirSync(path.join(SWIFT_DIRECTORY, directory)).filter((file) => file.endsWith(".swift")).sort();
}

export function writeXcodeProject(): string {
    const groups = [
        { name: "Shared", files: swiftFiles("Shared") },
        { name: "iOS", files: swiftFiles("iOS") },
    ];
    const sources = groups.flatMap((group) => group.files.map((file) => ({ group: group.name, file })));
    const ref = (group: string, file: string) => id(`ref:${group}/${file}`);
    const build = (group: string, file: string) => id(`build:${group}/${file}`);

    const target = id("target");
    const project = id("project");
    const mainGroup = id("group:main");
    const productsGroup = id("group:products");
    const generatedGroup = id("group:generated");
    const productRef = id("ref:product");
    const plistRef = id("ref:Generated/Info-iOS.plist");
    const xcconfigRef = id("ref:Generated/Site.xcconfig");
    const assetsRef = id("ref:Generated/Assets.xcassets");
    const assetsBuild = id("build:Generated/Assets.xcassets");
    const sourcesPhase = id("phase:sources");
    const frameworksPhase = id("phase:frameworks");
    const resourcesPhase = id("phase:resources");
    const projectConfigs = id("configs:project");
    const targetConfigs = id("configs:target");

    const shared: Settings = {
        ALWAYS_SEARCH_USER_PATHS: "NO",
        CLANG_ENABLE_MODULES: "YES",
        CLANG_ENABLE_OBJC_ARC: "YES",
        COPY_PHASE_STRIP: "NO",
        ENABLE_STRICT_OBJC_MSGSEND: "YES",
        ENABLE_USER_SCRIPT_SANDBOXING: "YES",
        GCC_NO_COMMON_BLOCKS: "YES",
        IPHONEOS_DEPLOYMENT_TARGET: DEPLOYMENT_TARGET,
        SDKROOT: "iphoneos",
        SWIFT_VERSION: "5.0",
    };
    const debug: Settings = {
        ...shared,
        DEBUG_INFORMATION_FORMAT: "dwarf",
        ENABLE_TESTABILITY: "YES",
        GCC_OPTIMIZATION_LEVEL: "0",
        GCC_PREPROCESSOR_DEFINITIONS: ["DEBUG=1", "$(inherited)"],
        ONLY_ACTIVE_ARCH: "YES",
        SWIFT_ACTIVE_COMPILATION_CONDITIONS: "DEBUG $(inherited)",
        SWIFT_OPTIMIZATION_LEVEL: "-Onone",
    };
    const release: Settings = {
        ...shared,
        DEBUG_INFORMATION_FORMAT: "dwarf-with-dsym",
        ENABLE_NS_ASSERTIONS: "NO",
        SWIFT_COMPILATION_MODE: "wholemodule",
        VALIDATE_PRODUCT: "YES",
    };
    // Per-site values (bundle id, version, team) come from Generated/Site.xcconfig, so they are not set here.
    const targetSettings: Settings = {
        ASSETCATALOG_COMPILER_APPICON_NAME: "AppIcon",
        CODE_SIGN_STYLE: "Automatic",
        GENERATE_INFOPLIST_FILE: "NO",
        INFOPLIST_FILE: "Generated/Info-iOS.plist",
        LD_RUNPATH_SEARCH_PATHS: ["$(inherited)", "@executable_path/Frameworks"],
        PRODUCT_NAME: "Stor",
        SUPPORTS_MAC_DESIGNED_FOR_IPHONE_IPAD: "NO",
        SUPPORTS_MACCATALYST: "NO",
        SUPPORTS_XR_DESIGNED_FOR_IPHONE_IPAD: "NO",
        SWIFT_EMIT_LOC_STRINGS: "YES",
        TARGETED_DEVICE_FAMILY: "1,2",
    };

    const config = (name: string, settings: Settings, base?: string) =>
        `\t\t${id(`config:${name}`)} /* ${name.split(":")[1]} */ = {\n\t\t\tisa = XCBuildConfiguration;\n${
            base ? `\t\t\tbaseConfigurationReference = ${base} /* Site.xcconfig */;\n` : ""
        }\t\t\tbuildSettings = {\n${settingsBlock(settings, "\t\t\t\t")}\n\t\t\t};\n\t\t\tname = ${name.split(":")[1]};\n\t\t};\n`;

    const text = `// !$*UTF8*$!
{
	archiveVersion = 1;
	classes = {
	};
	objectVersion = 56;
	objects = {

/* Begin PBXBuildFile section */
${sources.map(({ group, file }) => `\t\t${build(group, file)} /* ${file} in Sources */ = {isa = PBXBuildFile; fileRef = ${ref(group, file)} /* ${file} */; };`).join("\n")}
\t\t${assetsBuild} /* Assets.xcassets in Resources */ = {isa = PBXBuildFile; fileRef = ${assetsRef} /* Assets.xcassets */; };
/* End PBXBuildFile section */

/* Begin PBXFileReference section */
${sources.map(({ group, file }) => `\t\t${ref(group, file)} /* ${file} */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ${quote(file)}; sourceTree = "<group>"; };`).join("\n")}
\t\t${plistRef} /* Info-iOS.plist */ = {isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = "Info-iOS.plist"; sourceTree = "<group>"; };
\t\t${xcconfigRef} /* Site.xcconfig */ = {isa = PBXFileReference; lastKnownFileType = text.xcconfig; path = Site.xcconfig; sourceTree = "<group>"; };
\t\t${assetsRef} /* Assets.xcassets */ = {isa = PBXFileReference; lastKnownFileType = folder.assetcatalog; path = Assets.xcassets; sourceTree = "<group>"; };
\t\t${productRef} /* ${PRODUCT} */ = {isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = ${PRODUCT}; sourceTree = BUILT_PRODUCTS_DIR; };
/* End PBXFileReference section */

/* Begin PBXFrameworksBuildPhase section */
\t\t${frameworksPhase} /* Frameworks */ = {
\t\t\tisa = PBXFrameworksBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
/* End PBXFrameworksBuildPhase section */

/* Begin PBXGroup section */
\t\t${mainGroup} = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
${groups.map((group) => `\t\t\t\t${id(`group:${group.name}`)} /* ${group.name} */,`).join("\n")}
\t\t\t\t${generatedGroup} /* Generated */,
\t\t\t\t${productsGroup} /* Products */,
\t\t\t);
\t\t\tsourceTree = "<group>";
\t\t};
${groups.map((group) => `\t\t${id(`group:${group.name}`)} /* ${group.name} */ = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
${group.files.map((file) => `\t\t\t\t${ref(group.name, file)} /* ${file} */,`).join("\n")}
\t\t\t);
\t\t\tpath = ${quote(path.join(SWIFT_DIRECTORY, group.name))};
\t\t\tsourceTree = "<absolute>";
\t\t};`).join("\n")}
\t\t${generatedGroup} /* Generated */ = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
\t\t\t\t${plistRef} /* Info-iOS.plist */,
\t\t\t\t${xcconfigRef} /* Site.xcconfig */,
\t\t\t\t${assetsRef} /* Assets.xcassets */,
\t\t\t);
\t\t\tpath = Generated;
\t\t\tsourceTree = "<group>";
\t\t};
\t\t${productsGroup} /* Products */ = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
\t\t\t\t${productRef} /* ${PRODUCT} */,
\t\t\t);
\t\t\tname = Products;
\t\t\tsourceTree = "<group>";
\t\t};
/* End PBXGroup section */

/* Begin PBXNativeTarget section */
\t\t${target} /* ${SCHEME} */ = {
\t\t\tisa = PBXNativeTarget;
\t\t\tbuildConfigurationList = ${targetConfigs} /* Build configuration list for PBXNativeTarget "${SCHEME}" */;
\t\t\tbuildPhases = (
\t\t\t\t${sourcesPhase} /* Sources */,
\t\t\t\t${frameworksPhase} /* Frameworks */,
\t\t\t\t${resourcesPhase} /* Resources */,
\t\t\t);
\t\t\tbuildRules = (
\t\t\t);
\t\t\tdependencies = (
\t\t\t);
\t\t\tname = "${SCHEME}";
\t\t\tproductName = "${SCHEME}";
\t\t\tproductReference = ${productRef} /* ${PRODUCT} */;
\t\t\tproductType = "com.apple.product-type.application";
\t\t};
/* End PBXNativeTarget section */

/* Begin PBXProject section */
\t\t${project} /* Project object */ = {
\t\t\tisa = PBXProject;
\t\t\tattributes = {
\t\t\t\tBuildIndependentTargetsInParallel = 1;
\t\t\t\tLastSwiftUpdateCheck = 1600;
\t\t\t\tLastUpgradeCheck = 1600;
\t\t\t\tTargetAttributes = {
\t\t\t\t\t${target} = {
\t\t\t\t\t\tCreatedOnToolsVersion = 16.0;
\t\t\t\t\t};
\t\t\t\t};
\t\t\t};
\t\t\tbuildConfigurationList = ${projectConfigs} /* Build configuration list for PBXProject "Stor" */;
\t\t\tcompatibilityVersion = "Xcode 14.0";
\t\t\tdevelopmentRegion = en;
\t\t\thasScannedForEncodings = 0;
\t\t\tknownRegions = (
\t\t\t\ten,
\t\t\t\tBase,
\t\t\t);
\t\t\tmainGroup = ${mainGroup};
\t\t\tproductRefGroup = ${productsGroup} /* Products */;
\t\t\tprojectDirPath = "";
\t\t\tprojectRoot = "";
\t\t\ttargets = (
\t\t\t\t${target} /* ${SCHEME} */,
\t\t\t);
\t\t};
/* End PBXProject section */

/* Begin PBXResourcesBuildPhase section */
\t\t${resourcesPhase} /* Resources */ = {
\t\t\tisa = PBXResourcesBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
\t\t\t\t${assetsBuild} /* Assets.xcassets in Resources */,
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
/* End PBXResourcesBuildPhase section */

/* Begin PBXSourcesBuildPhase section */
\t\t${sourcesPhase} /* Sources */ = {
\t\t\tisa = PBXSourcesBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
${sources.map(({ group, file }) => `\t\t\t\t${build(group, file)} /* ${file} in Sources */,`).join("\n")}
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
/* End PBXSourcesBuildPhase section */

/* Begin XCBuildConfiguration section */
${config("project:Debug", debug)}${config("project:Release", release)}${config("target:Debug", targetSettings, xcconfigRef)}${config("target:Release", targetSettings, xcconfigRef)}/* End XCBuildConfiguration section */

/* Begin XCConfigurationList section */
\t\t${projectConfigs} /* Build configuration list for PBXProject "Stor" */ = {
\t\t\tisa = XCConfigurationList;
\t\t\tbuildConfigurations = (
\t\t\t\t${id("config:project:Debug")} /* Debug */,
\t\t\t\t${id("config:project:Release")} /* Release */,
\t\t\t);
\t\t\tdefaultConfigurationIsVisible = 0;
\t\t\tdefaultConfigurationName = Release;
\t\t};
\t\t${targetConfigs} /* Build configuration list for PBXNativeTarget "${SCHEME}" */ = {
\t\t\tisa = XCConfigurationList;
\t\t\tbuildConfigurations = (
\t\t\t\t${id("config:target:Debug")} /* Debug */,
\t\t\t\t${id("config:target:Release")} /* Release */,
\t\t\t);
\t\t\tdefaultConfigurationIsVisible = 0;
\t\t\tdefaultConfigurationName = Release;
\t\t};
/* End XCConfigurationList section */
\t};
\trootObject = ${project} /* Project object */;
}
`;

    const reference = `<BuildableReference
               BuildableIdentifier = "primary"
               BlueprintIdentifier = "${target}"
               BuildableName = "${PRODUCT}"
               BlueprintName = "${SCHEME}"
               ReferencedContainer = "container:Stor.xcodeproj">
            </BuildableReference>`;
    const scheme = `<?xml version="1.0" encoding="UTF-8"?>
<Scheme
   LastUpgradeVersion = "1600"
   version = "1.7">
   <BuildAction
      parallelizeBuildables = "YES"
      buildImplicitDependencies = "YES">
      <BuildActionEntries>
         <BuildActionEntry
            buildForTesting = "YES"
            buildForRunning = "YES"
            buildForProfiling = "YES"
            buildForArchiving = "YES"
            buildForAnalyzing = "YES">
            ${reference}
         </BuildActionEntry>
      </BuildActionEntries>
   </BuildAction>
   <TestAction
      buildConfiguration = "Debug"
      selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB"
      selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB"
      shouldUseLaunchSchemeArgsEnv = "YES">
      <Testables>
      </Testables>
   </TestAction>
   <LaunchAction
      buildConfiguration = "Release"
      selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB"
      selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB"
      launchStyle = "0"
      useCustomWorkingDirectory = "NO"
      ignoresPersistentStateOnLaunch = "NO"
      debugDocumentVersioning = "YES"
      debugServiceExtension = "internal"
      allowLocationSimulation = "YES">
      <BuildableProductRunnable
         runnableDebuggingMode = "0">
         ${reference}
      </BuildableProductRunnable>
   </LaunchAction>
   <ProfileAction
      buildConfiguration = "Release"
      shouldUseLaunchSchemeArgsEnv = "YES"
      savedToolIdentifier = ""
      useCustomWorkingDirectory = "NO"
      debugDocumentVersioning = "YES">
      <BuildableProductRunnable
         runnableDebuggingMode = "0">
         ${reference}
      </BuildableProductRunnable>
   </ProfileAction>
   <AnalyzeAction
      buildConfiguration = "Debug">
   </AnalyzeAction>
   <ArchiveAction
      buildConfiguration = "Release"
      revealArchiveInOrganizer = "YES">
   </ArchiveAction>
</Scheme>
`;

    mkdirSync(PROJECT_ROOT, { recursive: true });
    rmSync(PROJECT_DIRECTORY, { recursive: true, force: true });
    const schemes = path.join(PROJECT_DIRECTORY, "xcshareddata", "xcschemes");
    mkdirSync(schemes, { recursive: true });
    writeFileSync(path.join(PROJECT_DIRECTORY, "project.pbxproj"), text);
    writeFileSync(path.join(schemes, `${SCHEME}.xcscheme`), scheme);
    return PROJECT_DIRECTORY;
}
