import SwiftUI
@main
struct NotesApp: App {
 var body: some Scene {WindowGroup {NotesView().frame(width:620,height:430)}}
}
struct NotesView: View {
 @State private var text=""
 @State private var saved=UserDefaults.standard.string(forKey:"note") ?? ""
 @State private var status="Ready"
 func save(){if text.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty {status="Write a note first";return};saved=text;UserDefaults.standard.set(saved,forKey:"note");status="Saved";text=""}
 var body: some View {VStack(alignment:.leading,spacing:20){Text("Native notes").font(.largeTitle);TextField("Write a note",text:$text).accessibilityIdentifier("note").onSubmit(save);Button("Save",action:save).accessibilityIdentifier("save");Text(status).accessibilityIdentifier("status");Text(saved).accessibilityIdentifier("saved")}.padding(40)}
}
