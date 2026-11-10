import type { Config } from 'tailwindcss';
import path from 'path';

const root = path.resolve(__dirname);

/** Colour token backed by a CSS variable holding "r g b", so `/alpha` modifiers keep working. */
const token = (name: string) => `rgb(var(--color-${name}) / <alpha-value>)`;

export default {
  content: [
    path.join(root, 'index.html'),
    path.join(root, 'src/**/*.{ts,tsx}'),
  ],
  theme: {
    extend: {
      colors: {
        /*
         * Historical token names are kept so existing class names stay valid; the values live in
         * `src/index.css` (:root). teal / dark-teal / light-teal / deep-blue are the action colour,
         * navy / slate / mid-grey the text ramp, light-grey the app background, orange = warning.
         */
        telivity: {
          teal: token('primary'),
          'dark-teal': token('primary-strong'),
          'light-teal': token('primary-soft'),
          'deep-blue': token('primary-strong'),
          orange: token('warning'),
          'orange-lt': token('warning-soft'),
          yellow: token('attention'),
          purple: token('violet'),
          navy: token('ink'),
          slate: token('ink-2'),
          'mid-grey': token('ink-3'),
          'light-grey': token('canvas'),
        },
        primary: {
          50: token('primary-50'),
          100: token('primary-100'),
          200: token('primary-200'),
          300: token('primary-300'),
          400: token('primary-soft'),
          500: token('primary'),
          600: token('primary'),
          700: token('primary-strong'),
          800: token('primary-strong'),
          950: token('ink'),
          DEFAULT: token('primary'),
        },
        surface: token('surface'),
        line: token('line'),
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Arial', 'sans-serif'],
      },
      /* One step larger than Tailwind defaults: the UI is read for whole shifts. */
      fontSize: {
        xs: ['0.8125rem', { lineHeight: '1.125rem' }],   // 13 / 18
        sm: ['0.875rem', { lineHeight: '1.25rem' }],     // 14 / 20
        base: ['0.9375rem', { lineHeight: '1.375rem' }], // 15 / 22
        lg: ['1.0625rem', { lineHeight: '1.625rem' }],   // 17 / 26
        xl: ['1.25rem', { lineHeight: '1.75rem' }],      // 20 / 28
        '2xl': ['1.5rem', { lineHeight: '2rem' }],       // 24 / 32
      },
      borderRadius: {
        lg: '0.5rem',
        xl: '0.75rem',
      },
      boxShadow: {
        sm: '0 1px 2px 0 rgb(16 24 40 / 0.05)',
        DEFAULT: '0 1px 3px 0 rgb(16 24 40 / 0.08), 0 1px 2px -1px rgb(16 24 40 / 0.06)',
        md: '0 4px 8px -2px rgb(16 24 40 / 0.08), 0 2px 4px -2px rgb(16 24 40 / 0.05)',
        lg: '0 12px 24px -6px rgb(16 24 40 / 0.12), 0 4px 8px -4px rgb(16 24 40 / 0.06)',
      },
      keyframes: {
        'slide-in': {
          from: { opacity: '0', transform: 'translateX(100%)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        'pulse-skeleton': {
          '0%, 100%': { opacity: '0.4' },
          '50%': { opacity: '0.7' },
        },
        'pop-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'slide-in': 'slide-in 0.2s ease-out',
        'skeleton': 'pulse-skeleton 1.5s ease-in-out infinite',
        'pop-in': 'pop-in 0.12s ease-out',
      },
    },
  },
  plugins: [],
} satisfies Config;
