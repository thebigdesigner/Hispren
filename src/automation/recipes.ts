/**
 * THE RECIPE LIBRARY.
 *
 * A blank canvas is a graveyard.
 *
 * A church administrator is a volunteer with a day job. She is not an
 * automation engineer, and she did not come here to learn what a "trigger" is.
 * Hand her an empty builder and she will click around for four minutes, build
 * nothing, and never come back — and the most valuable feature in the product
 * will sit unused forever.
 *
 * So: eight recipes that work the moment she presses Use. She can edit them
 * afterwards, and most people never will, and that is fine — the defaults were
 * written by somebody who has thought about what a Nigerian church actually
 * needs on a Monday morning.
 */
export type Recipe = {
  key: string;
  name: string;
  why: string;                  // the reason a pastor should care
  trigger_type: string;
  trigger_config: any;
  allow_reenrollment?: boolean;
  reenroll_after_days?: number;
  steps: Array<{
    action_type: string;
    action_config: any;
    delay_minutes?: number;
    condition?: any;
  }>;
};

const DAY = 1440, HOUR = 60;

export const RECIPES: Recipe[] = [

  // ═══════════════════════════════════════════════════════════════════════
  {
    key: "welcome_first_timer",
    name: "Welcome a first timer, and make sure somebody calls them",
    why: "The first 72 hours decide whether they come back. Most churches mean " +
         "to call and then Sunday arrives again. This one does not forget.",
    trigger_type: "event",
    trigger_config: { event: "visitor.registered" },
    steps: [
      {
        action_type: "send_message",
        action_config: {
          name: "Welcome",
          channel: "whatsapp",
          body: "Hello {{first_name}}, thank you for worshipping with us at {{church}} today. " +
                "It was a joy to have you. We would love to see you again — and if there is " +
                "anything at all we can pray about with you, just reply to this message. " +
                "God bless you.",
        },
        delay_minutes: 0,
      },
      {
        // The MESSAGE is not the point. The CALL is the point.
        action_type: "create_task",
        action_config: {
          title: "Call {{name}} — they came for the first time",
          body: "A first timer. Ring them, ask how they found the service, and invite " +
                "them to a cell. Do not send a text — pick up the phone.",
          due_days: 2,
          priority: "high",
        },
        delay_minutes: 4 * HOUR,
      },
      {
        // Nobody called. Tell the pastor. This is the step that makes the
        // difference between a system and a filing cabinet.
        action_type: "notify_leader",
        action_config: {
          title: "NOBODY has called {{name}} yet",
          body: "They came for the first time three days ago and no one has reached out. " +
                "The window is closing.",
          due_days: 1,
          priority: "high",
        },
        delay_minutes: 3 * DAY,
        condition: { field: "stage_key", op: "in", value: ["visitor", "first_timer"] },
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  {
    key: "they_came_back",
    name: "They came back a second time",
    why: "A second visit is the strongest signal there is. Most churches miss it " +
         "entirely because nobody is counting.",
    trigger_type: "event",
    trigger_config: { event: "attendance.recorded" },
    allow_reenrollment: false,
    steps: [
      {
        action_type: "send_message",
        action_config: {
          name: "So glad you came back",
          channel: "whatsapp",
          body: "{{first_name}}, it was so good to see you again at {{church}}. " +
                "We would love you to join one of our house fellowships — they meet " +
                "midweek, near where you live. Would you like us to introduce you?",
        },
        delay_minutes: 6 * HOUR,
        condition: { field: "stage_key", op: "in", value: ["visitor", "first_timer"] },
      },
      {
        action_type: "change_stage",
        action_config: { stage: "convert" },
        delay_minutes: 0,
        condition: { field: "stage_key", op: "in", value: ["visitor", "first_timer"] },
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  {
    key: "missed_three_sundays",
    name: "Somebody has quietly stopped coming",
    why: "THIS IS THE ONE. A church loses people slowly, one Sunday at a time, and " +
         "nobody notices until they are gone. Three weeks is the point at which a " +
         "phone call still works.",
    trigger_type: "absence",
    trigger_config: { weeks: 3, stages: ["member", "worker", "leader", "convert"] },
    allow_reenrollment: true,
    reenroll_after_days: 60,
    steps: [
      {
        // NOT a message to the member. A message to their CELL LEADER.
        //
        // A machine-generated "we missed you!" to somebody whose mother died
        // last week, or who left after an argument with an usher, is worse than
        // silence. The machine notices. A HUMAN decides what to do about it.
        action_type: "notify_leader",
        action_config: {
          title: "{{name}} has not come for three weeks",
          body: "Ring them. Do not text. Ask how they are — there may be a reason, " +
                "and it may be one the church should know about.",
          due_days: 3,
          priority: "high",
        },
        delay_minutes: 0,
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  {
    key: "missed_six_weeks",
    name: "Six weeks gone — tell the pastor",
    why: "Nobody called at three weeks, or they called and it did not help. " +
         "This is the last point at which a church can still get somebody back.",
    trigger_type: "absence",
    trigger_config: { weeks: 6, stages: ["member", "worker", "leader"] },
    allow_reenrollment: true,
    reenroll_after_days: 120,
    steps: [
      {
        action_type: "create_task",
        action_config: {
          title: "PASTOR: {{name}} has been away six weeks",
          body: "Their cell leader was told three weeks ago. They are still not coming. " +
                "This one needs you.",
          due_days: 2,
          priority: "high",
        },
        delay_minutes: 0,
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  {
    key: "birthday",
    name: "Birthday",
    why: "Costs nothing on WhatsApp. Remembered forever.",
    trigger_type: "date",
    trigger_config: { field: "date_of_birth", days_offset: 0 },
    allow_reenrollment: true,
    reenroll_after_days: 300,
    steps: [
      {
        action_type: "send_message",
        action_config: {
          name: "Birthday",
          channel: "whatsapp",
          body: "Happy birthday {{first_name}}! Everyone at {{church}} is celebrating " +
                "with you today. May this new year of your life be full of grace, " +
                "and may God bless you and your family.",
        },
        delay_minutes: 0,
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  {
    key: "new_member_30d",
    name: "Thirty days in — invite them to foundation school",
    why: "The gap between joining and belonging. Churches lose people here and " +
         "never understand why.",
    trigger_type: "date",
    trigger_config: { field: "joined_at", days_offset: 30 },
    steps: [
      {
        action_type: "send_message",
        action_config: {
          name: "Foundation school",
          channel: "whatsapp",
          body: "{{first_name}}, you have been with us at {{church}} for a month now, " +
                "and we are so glad you are here. Our foundation class starts soon — " +
                "it is where you get to know the church, and the church gets to know you. " +
                "Would you like a place?",
        },
        delay_minutes: 0,
      },
      {
        action_type: "create_task",
        action_config: {
          title: "Get {{name}} into a cell",
          body: "A month in and not yet in a house fellowship. This is where churches " +
                "lose people.",
          due_days: 7,
        },
        delay_minutes: 2 * DAY,
        condition: { field: "home_group_id", op: "unset" },
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  {
    key: "first_gift",
    name: "Thank somebody for their first gift",
    why: "Named gifts only. Anonymous cash is never attributed to anybody — " +
         "thanking the wrong person for money they did not give is worse than " +
         "thanking nobody.",
    trigger_type: "event",
    trigger_config: { event: "giving.recorded" },
    allow_reenrollment: false,
    steps: [
      {
        action_type: "send_message",
        action_config: {
          name: "Thank you",
          channel: "whatsapp",
          // NO AMOUNT. Ever. Putting a number in a thank-you message means it
          // appears on a phone somebody else may be holding.
          body: "{{first_name}}, thank you for your gift to {{church}}. " +
                "It goes exactly where you said it should, and it is doing " +
                "exactly what you gave it for. God bless you.",
        },
        delay_minutes: 12 * HOUR,
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  {
    key: "no_cell",
    name: "Faithful, and belonging to nothing",
    why: "They come every single Sunday and they are in no cell, no department, " +
         "nothing. These are the people a church loses without ever noticing, " +
         "because on paper they look fine.",
    trigger_type: "schedule",
    trigger_config: { cron: "0 9 * * 1" },   // Monday 09:00
    steps: [
      {
        action_type: "create_task",
        action_config: {
          title: "{{name}} attends faithfully and belongs to nothing",
          body: "No cell, no department, no team. Get them into a house fellowship " +
                "before they drift.",
          due_days: 7,
        },
        delay_minutes: 0,
      },
    ],
  },
];

export function recipe(key: string): Recipe | undefined {
  return RECIPES.find((r) => r.key === key);
}
