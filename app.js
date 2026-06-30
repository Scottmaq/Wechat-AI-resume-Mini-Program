App({
  onLaunch() {
    if (wx.cloud) {
      wx.cloud.init({
        env: "your-cloud-env-id",
        traceUser: true
      });
    }
  },
  globalData: {
    lastResult: null
  }
});
