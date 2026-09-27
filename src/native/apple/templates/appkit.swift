import AppKit
final class NotesDelegate:NSObject,NSApplicationDelegate {
 var window:NSWindow!;let input=NSTextField(),saved=NSTextField(labelWithString:UserDefaults.standard.string(forKey:"note") ?? ""),status=NSTextField(labelWithString:"Ready")
 func applicationDidFinishLaunching(_ notification:Notification){
  window=NSWindow(contentRect:NSRect(x:0,y:0,width:620,height:430),styleMask:[.titled,.closable,.miniaturizable],backing:.buffered,defer:false);window.title="Native notes"
  let heading=NSTextField(labelWithString:"Native notes");heading.font = .systemFont(ofSize:28,weight:.bold)
  input.placeholderString="Write a note";input.setAccessibilityIdentifier("note");input.target=self;input.action=#selector(save)
  status.setAccessibilityIdentifier("status");saved.setAccessibilityIdentifier("saved")
  let button=NSButton(title:"Save",target:self,action:#selector(save));button.setAccessibilityIdentifier("save")
  let stack=NSStackView(views:[heading,input,button,status,saved]);stack.orientation = .vertical;stack.alignment = .leading;stack.spacing=20;stack.translatesAutoresizingMaskIntoConstraints=false
  window.contentView!.addSubview(stack);NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo:window.contentView!.leadingAnchor,constant:40),stack.trailingAnchor.constraint(equalTo:window.contentView!.trailingAnchor,constant:-40),stack.topAnchor.constraint(equalTo:window.contentView!.topAnchor,constant:40),input.widthAnchor.constraint(equalTo:stack.widthAnchor)])
  window.center();window.makeKeyAndOrderFront(nil);NSApp.activate(ignoringOtherApps:true)
 }
 @objc func save(){if input.stringValue.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty{status.stringValue="Write a note first";return};saved.stringValue=input.stringValue;UserDefaults.standard.set(saved.stringValue,forKey:"note");status.stringValue="Saved";input.stringValue=""}
 func applicationShouldTerminateAfterLastWindowClosed(_ sender:NSApplication)->Bool{true}
}
@main struct NativeNotes {static func main(){let app=NSApplication.shared;app.setActivationPolicy(.regular);let delegate=NotesDelegate();app.delegate=delegate;withExtendedLifetime(delegate){app.run()}}}
