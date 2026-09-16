module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      ["inline-import", { "extensions": [".sql"] }],
      // reanimated 4 ships its worklets transform here; must stay last.
      "react-native-worklets/plugin"
    ]
  };
};
