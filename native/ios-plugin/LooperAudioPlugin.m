#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

// Registers the Swift LooperAudio class with Capacitor so app.js can call it
// via Capacitor.registerPlugin('LooperAudio').
CAP_PLUGIN(LooperAudio, "LooperAudio",
  CAP_PLUGIN_METHOD(prepare, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(startRecord, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(stopRecord, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(startOverdub, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(finishOverdub, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(undo, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(clear, CAPPluginReturnPromise);
)
