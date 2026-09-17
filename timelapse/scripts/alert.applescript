-- Send an iMessage via Messages.app. Usage: osascript alert.applescript "<recipient>" "<text>"
-- The first run from a LaunchAgent triggers a macOS Automation permission prompt for node;
-- approve it in System Settings > Privacy & Security > Automation.
on run argv
	set theRecipient to item 1 of argv
	set theMessage to item 2 of argv
	tell application "Messages"
		set targetService to 1st account whose service type = iMessage
		set targetBuddy to participant theRecipient of targetService
		send theMessage to targetBuddy
	end tell
end run
