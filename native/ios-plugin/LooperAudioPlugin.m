#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

// Capacitor 6 needs BOTH this CAP_PLUGIN macro (registers the class with the
// runtime) and the Swift CAPBridgedPlugin conformance in LooperAudio.swift
// (declares the method metadata). Keep this file in the App target.
CAP_PLUGIN(LooperAudio, "LooperAudio",
  CAP_PLUGIN_METHOD(prepare, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(startRecord, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(stopRecord, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(startOverdub, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(finishOverdub, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(undo, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(clear, CAPPluginReturnPromise);
)
