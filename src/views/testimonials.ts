/**
 * Homepage testimonials (owner, 5 Nov 2026): names, schools and words exactly as the owner supplied them. The owner
 * confirms each student has approved the final wording before this section goes live.
 */
export type Testimonial = { name: string; school: string; quote: string; portrait: number };
export const TESTIMONIALS: Testimonial[] = [
  {
    "name": "Mohammed",
    "school": "St. George’s University",
    "quote": "I actually flew all the way to Houston for a 5-week USMLE prep course because they promised I’d be ready for my exam. I spent thousands of dollars just sitting through PowerPoints while they rushed through everything, and somehow my NBME scores were even lower when I finished. I honestly felt scammed and had no idea what to do next. Then I came across USMLE100 in a Facebook group and decided to reach out. I can’t explain it, but finding this program felt like a guardian angel was looking out for me. The professor actually took the time to sit with me for hours, explain the important concepts, and show me how to approach questions. So much of what we covered showed up on my actual exam, it was unbelievable. I went from always running out of time to actually finishing my blocks early. I just wish I’d found this program before spending all that money in Houston.",
    "portrait": 0
  },
  {
    "name": "Maria",
    "school": "Ross University",
    "quote": "I did the whole thing, Kaplan, First Aid, UWorld, YouTube videos, all of it. And honestly, looking back, I spent so much time and money trying to figure out what I was supposed to be studying. I really wish someone had told me about USMLE100 sooner because I could’ve saved myself a lot of frustration. My younger sister just got into Ross, and I’ve already told her about this program. I’m not going to let her spend years jumping between resources like I did. If there’s one thing I regret, it’s not finding USMLE100 earlier.",
    "portrait": 1
  },
  {
    "name": "Elijah",
    "school": "Lake Erie College of Osteopathic Medicine",
    "quote": "Man, I had already gone through Boards and Beyond, Pathoma, read First Aid three times, and finished UWorld twice, and my NBME scores were still stuck in the 50s. I had already postponed my exam and was about to lose my exam fee again, so I was getting pretty desperate. Then this guy from my class, who I swear was always out partying, posted that he passed Step 1, and I had to ask him how he did it. He told me about USMLE100, so I went to their website ready to pay for the entire course. The funny thing is, when I spoke to the professor, he actually told me not to buy it and recommended one-on-one tutoring instead. I couldn’t believe it because I literally had my credit card ready, and he could’ve easily taken my money. I did an hour of tutoring a day for two weeks, went in for my exam, and passed Step 1. That’s the kind of honesty you don’t come across very often, and it’s why I tell other students about this program.",
    "portrait": 4
  },
  {
    "name": "Jennifer",
    "school": "East Carolina University",
    "quote": "I spent almost two years preparing for this exam, and I was so tired of studying something only to forget it a week later. I even hired a tutor I found on Instagram who scored over 270, thinking he must be an amazing teacher. I was paying him $70 an hour, and every time I asked him to explain something, he’d just tell me to memorize it or read First Aid again. I mean, I’d already read that book five times, what was I paying him for? What I liked about USMLE100 was that the professor didn’t expect me to memorize everything without understanding it. He explained why an answer was right, what clues to look for, and how to eliminate the other choices. I could actually remember his explanations when I was sitting in the exam. It made me realize that scoring high on a test and knowing how to teach someone are two completely different things.",
    "portrait": 5
  },
  {
    "name": "Amelia",
    "school": "Howard University College of Medicine",
    "quote": "There was a point when I genuinely thought I wasn’t going to make it through medical school. I’d tried so many resources, spent money I really didn’t have, and still couldn’t get where I needed to be. My school wasn’t giving me much support, and I remember crying at night because I was scared of getting dismissed. I started questioning whether I was even capable of becoming a doctor. A friend recommended USMLE100, and honestly, I wasn’t expecting much because nothing else had worked. But the way the professor explained things finally made sense to me, and little by little I started feeling confident again. When I found out I passed, I just sat there crying. I don’t think I’ll ever forget that moment because it felt like I was getting my future back.",
    "portrait": 3
  },
  {
    "name": "José",
    "school": "American University of the Caribbean School of Medicine (AUC)",
    "quote": "Honestly, the small class sizes were one of my favorite things about USMLE100. I never felt like I was just another student sitting in a lecture because the professor actually knew what I was struggling with. The one-on-one tutoring was really interactive, and we spent time going over the questions I kept getting wrong. After just one session, my UWorld score went up 15 percentage points, which was crazy to me because I’d always been stuck in the 60s and 70s. I’d never even scored an 80 on a block before. What helped me the most was learning how to break down questions instead of second-guessing every answer. I really recommend this program to anyone who feels like they’re studying all day but their scores aren’t improving.",
    "portrait": 2
  }
];

/** Shown once, under both rows, exactly as worded by the owner. */
export const TESTIMONIAL_DISCLAIMER = "Testimonials are furnished in an individual capacity. Institutional designations are for identification only and shall not be construed as institutional endorsement, sponsorship, or authorization.";
