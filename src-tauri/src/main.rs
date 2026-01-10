// Kein Konsolenfenster unter Windows im Release-Build
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    fernwerk_lib::run()
}
