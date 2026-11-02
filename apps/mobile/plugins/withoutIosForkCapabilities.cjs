const { withEntitlementsPlist } = require("expo/config-plugins");

// An empty associated-domains key would still make automatic signing enable the capability.
module.exports = function withoutIosForkCapabilities(config) {
  return withEntitlementsPlist(config, (modConfig) => {
    delete modConfig.modResults["aps-environment"];
    delete modConfig.modResults["com.apple.developer.associated-domains"];
    return modConfig;
  });
};
