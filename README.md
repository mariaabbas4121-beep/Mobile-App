# Course

Project Name : NeighborShare
Platform : React Native (Expo Router)
Backend : Firebase Authentication & Cloud Firestore
Course : Mobile Application Development
Submitted By : Maria Abbas (2023-ag-9845)

OVERVIEW

NeighborShare is a community-based mobile application that allows users to lend and borrow items within their neighborhood. The application helps users share resources efficiently by providing item listings, borrowing requests, lending management, location-based item discovery, activity tracking, and secure user authentication.

The application includes:

• User Registration and Login
• Browse Available Items
• Item Details View
• Add New Items for Lending
• Map-Based Item Discovery
• Activity Tracking
• User Profile Management
• Secure Authentication using Firebase

PREREQUISITES

• Node.js (v18 or later)
• npm
• Expo CLI
• Firebase Account
• Android Studio Emulator OR Expo Go Application

SETUP STEPS

STEP 1 — Clone the Repository 
GITHUB REPOSITORY

git clone https://github.com/mariaabbas4121-beep/Mobile-App

cd NeighborShare

STEP 2 — Install Dependencies

npm install

STEP 3 — Configure Firebase

Open Firebase Console
Create a Firebase Project named NeighborShare

Enable:

• Firebase Authentication (Email/Password)

• Cloud Firestore Database

Create a Web App
Copy Firebase Configuration

Open:

firebase/config.ts

Replace with your Firebase credentials:

const firebaseConfig = {
apiKey: "YOUR_API_KEY",
authDomain: "YOUR_PROJECT.firebaseapp.com",
projectId: "YOUR_PROJECT_ID",
storageBucket: "YOUR_PROJECT.appspot.com",
messagingSenderId: "YOUR_SENDER_ID",
appId: "YOUR_APP_ID"
};

STEP 4 — Start Application

npx expo start

Then choose:

• Press W → Open Web Version

• Press A → Android Emulator

• Scan QR Code using Expo Go

FIRESTORE DATABASE COLLECTIONS

Users Collection

• User ID

• Full Name

• Email Address

• Profile Information




PROJECT STRUCTURE

NeighborShare/

├── app/

│ ├── auth/

│ │ ├── welcome.tsx

│ │ ├── login.tsx

│ │ └── signup.tsx

│ │

│ ├── (tabs)/

│ │ ├── index.tsx

│ │ ├── map.tsx

│ │ ├── activity.tsx

│ │ └── profile.tsx

│ │

│ ├── item/

│ │ └── [id].tsx

│ │

│ └── lend/

│ └── new.tsx

│

├── components/

│ └── CustomButton.tsx

│

├── context/

│ └── AppContext.tsx

│

├── utils/

│ ├── theme.ts

│ └── helpers.ts

│

├── assets/

├── firebase/

├── package.json

└── README.txt
