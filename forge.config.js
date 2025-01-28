const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

module.exports = {
  packagerConfig: {
    asar: true, // Package app files into an ASAR archive
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel', // Windows Installer
      platforms: ['win32'], // Ensure it's explicitly for Windows
      config: {
        name: 'note_taker',
        setupIcon: './icon3.ico', // Path to your app icon
        setupExe: 'NoteTakerSetup.exe', // Name of the installer
        setupMsi: 'NoteTakerSetup.msi', // Optional: MSI installer if needed
        noMsi: true, // Disable MSI creation if not needed
      },
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives', // Automatically unpacks native modules
      config: {},
    },
    // Secure Electron with Fuses
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
