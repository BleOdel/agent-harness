// Harness-owned guest driver. Expected values are never included in this request.
import Foundation
import AppKit
import ApplicationServices
import ScreenCaptureKit
func failure(_ message:String)->NSError {NSError(domain:message,code:1)}
func attribute(_ element:AXUIElement,_ name:String)->Any? {
 var value:CFTypeRef?;guard AXUIElementCopyAttributeValue(element,name as CFString,&value) == .success else{return nil};return value
}
func descendants(_ root:AXUIElement)throws->[AXUIElement] {
 var queue=[root],result:[AXUIElement]=[]
 while !queue.isEmpty {
  let e=queue.removeFirst();if result.contains(where:{CFEqual($0,e)}){continue}
  if result.count>=2000 {throw failure("Accessibility tree exceeds 2000 elements")}
  result.append(e);queue += attribute(e,kAXChildrenAttribute) as? [AXUIElement] ?? []
 }
 return result
}
@main struct Driver {
 @MainActor static func main() async {
  let directory=FileManager.default.currentDirectoryPath
  var report:[String:Any] = ["version":1,"packaged":true,"steps":[],"errors":[]]
  var observations:[[String:Any]]=[];var running:NSRunningApplication?;var stepNumber=0
  func save(){report["steps"]=observations;if let bytes=try? JSONSerialization.data(withJSONObject:report,options:.sortedKeys){try? bytes.write(to:URL(fileURLWithPath:directory+"/observations.json"))}}
  do {
   let application=NSApplication.shared;application.setActivationPolicy(.accessory);application.finishLaunching()
   guard AXIsProcessTrusted() else {throw failure("Guest harness driver lacks Accessibility permission")}
   let request=try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:directory+"/apple-actions.json"))) as! [String:Any]
   let appURL=URL(fileURLWithPath:directory+"/"+(request["app"] as! String))
   guard let bundle=Bundle(url:appURL),bundle.bundleIdentifier != nil,bundle.executableURL != nil else {throw failure("Build did not produce a valid .app bundle")}
   func pause() async throws {try await Task.sleep(nanoseconds:100_000_000)}
   func launch() async throws -> AXUIElement {
    let configuration=NSWorkspace.OpenConfiguration();configuration.activates=true;configuration.createsNewApplicationInstance=true
    let app=try await NSWorkspace.shared.openApplication(at:appURL,configuration:configuration);running=app
    let root=AXUIElementCreateApplication(app.processIdentifier);AXUIElementSetMessagingTimeout(root,2)
    let deadline=Date().addingTimeInterval(15)
    while Date()<deadline {
     if app.isTerminated {throw failure("Native app exited before a window became available")}
     if let windows=attribute(root,kAXWindowsAttribute) as? [AXUIElement],windows.count==1 {return root}
     try await pause()
    }
    throw failure("Native app must expose exactly one accessibility window")
   }
   func stop() async throws {
    guard let app=running else{return};app.terminate();let deadline=Date().addingTimeInterval(5)
    while !app.isTerminated && Date()<deadline {try await pause()}
    if !app.isTerminated {app.forceTerminate();throw failure("Native app did not terminate normally")};running=nil
   }
   var root=try await launch()
   func matches(_ id:String)throws->[AXUIElement] {try descendants(root).filter{attribute($0,"AXIdentifier") as? String == id}}
   func element(_ id:String) async throws -> AXUIElement {
    let deadline=Date().addingTimeInterval(8)
    while Date()<deadline {let all=try matches(id);if all.count>1{throw failure("Accessibility identifier is ambiguous: "+id)};if let e=all.first{return e};try await pause()}
    throw failure("Accessibility identifier not found: "+id)
   }
   let steps=request["steps"] as! [[String:Any]]
   for (index,step) in steps.enumerated() {
    stepNumber=index+1;let action=step["action"] as! String;var observed:[String:Any]=["action":action]
    if running?.isTerminated != false {throw failure("Native app exited during its journey")}
    let windows=attribute(root,kAXWindowsAttribute) as? [AXUIElement] ?? [];if windows.count != 1 {throw failure("Journey requires one native window")}
    if action=="restart" {try await stop();root=try await launch()}
    else if action=="count" {try await Task.sleep(nanoseconds:500_000_000);observed["value"]=try matches(step["selector"] as! String).count}
    else if action=="screenshot" {
     guard CGPreflightScreenCaptureAccess() else {throw failure("Guest driver lacks screen capture permission")}
     let content=try await SCShareableContent.excludingDesktopWindows(true,onScreenWindowsOnly:true)
     let windows=content.windows.filter{$0.owningApplication?.processID==running!.processIdentifier && $0.windowLayer==0}
     guard windows.count==1 else {throw failure("Screenshot requires exactly one app window")}
     let window=windows[0],configuration=SCStreamConfiguration()
     configuration.width=Int(window.frame.width)*2;configuration.height=Int(window.frame.height)*2;configuration.showsCursor=false
     guard configuration.width>0 && configuration.height>0 && configuration.width<=4096 && configuration.height<=4096 else {throw failure("App window exceeds screenshot bounds")}
     let image=try await SCScreenshotManager.captureImage(contentFilter:SCContentFilter(desktopIndependentWindow:window),configuration:configuration)
     guard let png=NSBitmapImageRep(cgImage:image).representation(using:.png,properties:[:]),png.count<=4*1024*1024 else {throw failure("Screenshot exceeds retained output bound")}
     let name="screen-\(index).png";try png.write(to:URL(fileURLWithPath:directory+"/"+name));observed["file"]=name
    }else{
     let e=try await element(step["selector"] as! String)
     if action=="fill" {guard AXUIElementSetAttributeValue(e,kAXValueAttribute as CFString,(step["value"] as! String) as CFString) == .success else {throw failure("Native control rejected input")}}
     else if action=="click" {guard AXUIElementPerformAction(e,kAXPressAction as CFString) == .success else {throw failure("Native control rejected press action")}}
     else if action=="press" {
      guard AXUIElementSetAttributeValue(e,kAXFocusedAttribute as CFString,kCFBooleanTrue) == .success else {throw failure("Native control could not receive keyboard focus")}
      running!.activate(options:[.activateIgnoringOtherApps]);try await pause()
      let keys:[String:CGKeyCode] = ["Enter":36,"Tab":48,"Space":49,"Escape":53,"ArrowUp":126,"ArrowDown":125]
      guard let key=keys[step["key"] as! String],let down=CGEvent(keyboardEventSource:nil,virtualKey:key,keyDown:true),let up=CGEvent(keyboardEventSource:nil,virtualKey:key,keyDown:false) else {throw failure("Unsupported keyboard action")}
      down.postToPid(running!.processIdentifier);try await pause();up.postToPid(running!.processIdentifier)
     }else if action=="text" {
      var values:[String]=[]
      for _ in 0..<8 {let current=try await element(step["selector"] as! String);let value=(attribute(current,kAXValueAttribute) as? String) ?? (attribute(current,kAXTitleAttribute) as? String) ?? "";guard value.count<=10000 else {throw failure("Native text exceeds observation bound")};values.append(value);try await Task.sleep(nanoseconds:250_000_000)}
      observed["values"]=values
     }else{throw failure("Unsupported native action")}
    }
    observations.append(observed)
   }
   try await stop();save();print("Native UI observations ready")
  }catch{report["errors"]=[String("Step \(stepNumber): \(error.localizedDescription)").prefix(2000).description];save();fputs("Native UI step \(stepNumber): \(error)\n",stderr);running?.forceTerminate();exit(1)}
 }
}
