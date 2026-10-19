import React from 'react';
import {
TouchableOpacity,
Text,
StyleSheet,
ActivityIndicator,
} from 'react-native';

interface CustomButtonProps {
title: string;
onPress: () => void;
loading?: boolean;
}

export default function CustomButton({
title,
onPress,
loading = false,
}: CustomButtonProps) {
return ( <TouchableOpacity
   style={styles.button}
   onPress={onPress}
   disabled={loading}
 >
{loading ? ( <ActivityIndicator color="#fff" />
) : ( <Text style={styles.buttonText}>{title}</Text>
)} </TouchableOpacity>
);
}

const styles = StyleSheet.create({
button: {
backgroundColor: '#1b5e20',
paddingVertical: 14,
paddingHorizontal: 20,
borderRadius: 12,
alignItems: 'center',
justifyContent: 'center',
},
buttonText: {
color: '#fff',
fontSize: 16,
fontWeight: '600',
},
});
